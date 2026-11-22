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
		buildId: "4f4b069619c6-d8db03cb",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"e5d536cc447e9a85\",\"/knowledge-medium/index.html\":\"e5d536cc447e9a85\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-BNfV4Mnr.js\":\"c55827650f358c5f\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"c72e4126a60c12fa\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-CR7RPzVf.js\":\"29a82e0047a42941\",\"/knowledge-medium/chunks/FacadeVFS-DHPv7Ukk.js\":\"3f52fcbccb872de7\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-B6DHRo-P.js\":\"eb8e78b82db9260a\",\"/knowledge-medium/chunks/MemoryVFS-DI868hAm.js\":\"5481a49725909b41\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-DRuhgv7P.js\":\"9c179c0c392da642\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-DmEnkD1k.js\":\"0a66e5b1a0694fd0\",\"/knowledge-medium/chunks/Preview-VHWVU_kM.js\":\"8fedeb3f53aa4398\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-DO2OJzpB.js\":\"fbffe18e28d2b2b8\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-Dh0UstQm.js\":\"ab77e5e228a9c796\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-B61hyL66.js\":\"ee2b198e81d9e48e\",\"/knowledge-medium/chunks/react-BxPVQQtv.js\":\"3aa2e7f3a0dd915c\",\"/knowledge-medium/chunks/react-CjSNtsYy.js\":\"811e30f27828637e\",\"/knowledge-medium/chunks/react-Cs0bwUFc.js\":\"963a8039632926bb\",\"/knowledge-medium/chunks/react-DFZbU8ZI.js\":\"309556f0f0fc977b\",\"/knowledge-medium/chunks/react-DwZ-MeuC.js\":\"73180ed091b536b4\",\"/knowledge-medium/chunks/react-K0bZzcfy.js\":\"c9efb88666261fcb\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-DAO_8mHC.js\":\"cea427891e490a20\",\"/knowledge-medium/chunks/react-dom-server.browser.production-C0zLRQoW.js\":\"ed5dacf722e949b4\",\"/knowledge-medium/chunks/react-dom-server.edge.production-B_trOD_C.js\":\"cf34a1c6ed8702c1\",\"/knowledge-medium/chunks/react-ugMEe5gR.js\":\"25308b1715f14fca\",\"/knowledge-medium/chunks/server.browser-CRoJtxKj.js\":\"464d8a2ba3790e3b\",\"/knowledge-medium/chunks/textarea-Cph9pmeg.js\":\"7a4d4de479318edb\",\"/knowledge-medium/chunks/ui-Cre1OIMs.js\":\"de31e39264deb959\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"0facf9c6f933ceaf\",\"/knowledge-medium/src/appUpdate.js\":\"66fefb30274c3f5b\",\"/knowledge-medium/src/appVersion.js\":\"c43e4dc3c441f477\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"7600af66fdd58078\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"e0d1643ac6c07e95\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"43398f88adccac43\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"6a5f693d22629cf0\",\"/knowledge-medium/src/components/BlockComponent.js\":\"365a6cb3dd98df65\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"64b01e97f2640510\",\"/knowledge-medium/src/components/BlockEditor.js\":\"9e02c8cac2a17737\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"9aa34f750c32d250\",\"/knowledge-medium/src/components/BlockProperties.js\":\"c9cd80d15c9a2abf\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"7340a8ef685db45e\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"6c223a9b96e507c2\",\"/knowledge-medium/src/components/DividerHandle.js\":\"442b0062198347d5\",\"/knowledge-medium/src/components/DraftEditor.js\":\"af374b6ca49a12f8\",\"/knowledge-medium/src/components/GutterPill.js\":\"4ef200b49901641b\",\"/knowledge-medium/src/components/Header.js\":\"802fa1bdf57dd4bb\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"3d616047d74e101b\",\"/knowledge-medium/src/components/Login.js\":\"e4c2c61bc6588f9b\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"f7b25dd585b6a7dd\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"2e2fc919f634d83a\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"70547fea59aa71e8\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"02ce3d294fc45de7\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"0c2f4f1c37bf15bf\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"dc136d2393503242\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"b0e8f647c1be1e7d\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"7adec7730890bde7\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"d2c8708f46b45448\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"83ae2a136f63d305\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"fe9b38e1fb91d601\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"18a23c265ab546f4\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"053daed4e619b23e\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"a0874c981e87e047\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"8a71799d8bc2a48e\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"f5ae8f50baedbd91\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"695ce5f056886407\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"b60a5ddbab128c55\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"7357f868fc66e2a0\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"60da8ff1bb67bd26\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"28398793ceb01553\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"5a449e7da556ed3f\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"356aa22112370e5f\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"22313996fdbdf6ef\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"557abba87faf1a68\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"26df4b0b8ebc38d5\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"4f766cf62331b3dc\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"d3e94b2b33d1e7c1\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"33823d130e1d8377\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"c7576f76ee882bd1\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"2e11b92c0eecaace\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"3405a498ade74590\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"3913598ee1dae002\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"bcc326779b5110a9\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"1434d743b53f7691\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"21616de973b7533e\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"33d215aee36d03d3\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"4a455cd75deca959\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"73857590d001eeb6\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"603c08d272eaa47d\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"afabd9707947d636\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"e2bc765f2904f0c0\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"231954ccec393243\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"16193c73a1906682\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"2cf090972ab5fdc1\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"e63cb44f781c22fd\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"1dfef573547810f9\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"8f4b50f1a75a4c24\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"93d4a88344a7a878\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"57ec71aed5444fde\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"4d7985705e44b5b2\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"67c473b0df45411e\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"e19cdacf635b0e71\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"9b09b8e0741dc94a\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"4731631c4b37cb7a\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"66db3a640fab73b5\",\"/knowledge-medium/src/components/ui/button.js\":\"00fbb7a3dbf5f4ae\",\"/knowledge-medium/src/components/ui/card.js\":\"0a0c135a272964c1\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"b317c474385ba88b\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"bfdc9420942cf287\",\"/knowledge-medium/src/components/ui/command.js\":\"a75e2edea5f7d50b\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"b7c6786d9695852e\",\"/knowledge-medium/src/components/ui/dialog.js\":\"39e244a4b1059cd2\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"22a59289fda40059\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"d4889721eb405e9e\",\"/knowledge-medium/src/components/ui/index.js\":\"129441a2bba488cc\",\"/knowledge-medium/src/components/ui/input.js\":\"ebdb23e44b3afe33\",\"/knowledge-medium/src/components/ui/kbd.js\":\"90ba552c8d527e27\",\"/knowledge-medium/src/components/ui/label.js\":\"35e702d71c22b34a\",\"/knowledge-medium/src/components/ui/textarea.js\":\"d54a6011d51dd0dd\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"f8c8f3b5bad39cd1\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"bb3708f1941e8a82\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"aebd334e4fa55943\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"2b9232d6e1e0c0b6\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"815c39ae9497c888\",\"/knowledge-medium/src/components/util/error.js\":\"2bd518f3c41c5662\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"ef9a390074ad623e\",\"/knowledge-medium/src/components/util/suspense.js\":\"1a2f73ab6a05af04\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"319ecbdfda8d1efa\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"832cf78d949e3251\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"009974396cbd8679\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"fe741758cc41dfc0\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"7bd4f8dc46cc73fb\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"8c9b14ffa57a45dd\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"3b659e82ab97d6a2\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"ac499677976ed892\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"dc0f83fbabed7e07\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"ff11e10ea13c4868\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"29465dc04fea9e49\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"fb8e5ce7b1f26305\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"97aa0a8ce56cb483\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"3cfe81b335750620\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"2b8eaa577dcefe07\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"6321c52184e97a48\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"753c4934f455444b\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"22cac670c5802f5b\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"a82a149a37813a4d\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"3b811833744dca0a\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"23475f59059fbbdf\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"ef836e43de8f5390\",\"/knowledge-medium/src/context/block.js\":\"0d5b67f6006315c2\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"21172214c7860065\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"790174c615915c38\",\"/knowledge-medium/src/context/repo.js\":\"c82b39c8f82c92bb\",\"/knowledge-medium/src/data/aliasClaim.js\":\"b9a19606b4549042\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"99d07ae737735f9c\",\"/knowledge-medium/src/data/api/blockData.js\":\"c739a6593ae22ba4\",\"/knowledge-medium/src/data/api/blockType.js\":\"f094a3391f968774\",\"/knowledge-medium/src/data/api/changeScope.js\":\"e1fae62e507bb018\",\"/knowledge-medium/src/data/api/codecs.js\":\"f3a3719f3c32a4d7\",\"/knowledge-medium/src/data/api/derivedData.js\":\"7cd954a3f6e00d49\",\"/knowledge-medium/src/data/api/errors.js\":\"48fedc124ff75ae1\",\"/knowledge-medium/src/data/api/events.js\":\"c7221ac405078009\",\"/knowledge-medium/src/data/api/handle.js\":\"d1171f0812433abe\",\"/knowledge-medium/src/data/api/index.js\":\"72f1b239f4a4ec00\",\"/knowledge-medium/src/data/api/mutator.js\":\"0d47ba634030cb52\",\"/knowledge-medium/src/data/api/processor.js\":\"95e79893978d8485\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"3a2a5d6ad7f870ff\",\"/knowledge-medium/src/data/api/query.js\":\"2f5661e8464e8aca\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"2e4624d3ca0a9984\",\"/knowledge-medium/src/data/api/schema.js\":\"d1171f0812433abe\",\"/knowledge-medium/src/data/api/tx.js\":\"d1171f0812433abe\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"23cd7696ad9254cb\",\"/knowledge-medium/src/data/api/user.js\":\"f4089b1bdf5fa412\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"f7be2138588bdd22\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"25f184a39c9aa107\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"7f3c8ce2b1b0e82b\",\"/knowledge-medium/src/data/block.js\":\"326977f23b88cd02\",\"/knowledge-medium/src/data/blockCache.js\":\"c49f927f464ec85d\",\"/knowledge-medium/src/data/blockId.js\":\"a18f1db8d461b2ab\",\"/knowledge-medium/src/data/blockLiveness.js\":\"5aaae824c864072c\",\"/knowledge-medium/src/data/blockMerge.js\":\"d534b26455fded9c\",\"/knowledge-medium/src/data/blockSchema.js\":\"36505287d795727b\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"4f37434bd6c1935c\",\"/knowledge-medium/src/data/blockTypes.js\":\"8fe66a1d4c9c44d2\",\"/knowledge-medium/src/data/clientContext.js\":\"8dd3342169b7480f\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"1729b3424ca0e9aa\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"bda961a0c2d8afd9\",\"/knowledge-medium/src/data/derivedIds.js\":\"27709189adcd5538\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"5bf3fbf137e4fbde\",\"/knowledge-medium/src/data/facetBridge.js\":\"de45adfab777c8a6\",\"/knowledge-medium/src/data/facets.js\":\"614c96e904170cf1\",\"/knowledge-medium/src/data/globalState.js\":\"ac2a3e1f05864430\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"ef3a19f7c244a555\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"5db2346fdf353814\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"33e08a46ccc465e1\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"68379a64f06217a6\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"4207364155dc5d01\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"7a7666f39a53b67f\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"220643015bfaef35\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"04ce02c0de4574be\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"e2f0b0da2548f518\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"08f0713001e65668\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"2b348ade40053de3\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"12e2f9d6b262d12e\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"845b230a75c698c0\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"81a22803afbc25f1\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"b9040d9066425712\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"de7b87f0c275cd2f\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"98e1ff6ec1b90645\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"100352c19291f4a8\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"9d27dbadd8ba8804\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"58c01301b3680cc6\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"5c1199589542156d\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"a1230a66cfeec778\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"174bbd512e7f4b7d\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"a2c633e32aaa1fd9\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"915c806d78d98a63\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"7ee12ccb8bfd0d9f\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"8641a55e757ece93\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"0f142033c7bb11d0\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"dd26361373447439\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"cd2b51bebd7649a2\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"5b8a323a172577bc\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"177eab37744049b9\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"737b13d3bdd5a89c\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"cf1da4408c8c1682\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"d046d023764ec624\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"e61cbf19f9d37d3f\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"675cd1287fb74deb\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"19e54cd13295a818\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"21f0e4a74dd145d7\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"524648b2ec429968\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"779320661170e479\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"76940746ae92e02c\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"7da4b0e131b7e008\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"b593af6a8ee1c3f1\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"9176a8786ed6f79e\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"b43f8de588ee35db\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"a5ce5de4fe996ba0\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"d76e23a2efa0f8cf\",\"/knowledge-medium/src/data/invalidation.js\":\"8201696606b4174c\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"c9d3c988a417edfc\",\"/knowledge-medium/src/data/kernelPage.js\":\"435bab075159657e\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"74c5cea1f7e34ec5\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"bd00484aee2ccbc9\",\"/knowledge-medium/src/data/localDbStorage.js\":\"60909e3b6461a4a3\",\"/knowledge-medium/src/data/localDbVfs.js\":\"6c9fa1228e78d692\",\"/knowledge-medium/src/data/localSchema.js\":\"ac89956e08966b76\",\"/knowledge-medium/src/data/maintenance.js\":\"000fbdea0379879a\",\"/knowledge-medium/src/data/mergeProperties.js\":\"6839b4bd4d3286af\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"9ff81feaf8c585f0\",\"/knowledge-medium/src/data/migrationsPage.js\":\"60c5bcba7d8e746c\",\"/knowledge-medium/src/data/mutators.js\":\"93c664b040149399\",\"/knowledge-medium/src/data/orderKey.js\":\"e91c85275e9d84fc\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"fef331d778706bec\",\"/knowledge-medium/src/data/outlineSurface.js\":\"d65ca75f6ece6a7e\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"703e6641fbe3066c\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"3e47e69fc5ceccb8\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"4a38e6ba3576eafe\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"be7342d5e525c8f1\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"74bdf1b1cd98703c\",\"/knowledge-medium/src/data/properties.js\":\"3a3fce2783e11cd1\",\"/knowledge-medium/src/data/propertiesPage.js\":\"9123e8444f8be521\",\"/knowledge-medium/src/data/propertyChildren.js\":\"a206f15cf2ac5483\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"e95c848f3186aa3e\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"0a2a4b1be08a0c2c\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"ec24d9a69a837e05\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"410e31b49489bfc9\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"3a82fb5bdc90f897\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"bad0ec79184f624e\",\"/knowledge-medium/src/data/propertySeeds.js\":\"a40485f7fc4d387f\",\"/knowledge-medium/src/data/recentsPage.js\":\"21cf7ae071106e06\",\"/knowledge-medium/src/data/referenceBlock.js\":\"0edd4eb990838ba6\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"35b0078e9eb7265c\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"097f2922157a5135\",\"/knowledge-medium/src/data/repo.js\":\"4aae0cab2b452fa4\",\"/knowledge-medium/src/data/repoProvider.js\":\"7d55a98b332e14b7\",\"/knowledge-medium/src/data/rowProperty.js\":\"c98229116c615961\",\"/knowledge-medium/src/data/searchFilter.js\":\"6221c23ead92fa54\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"87a6549b519afa1f\",\"/knowledge-medium/src/data/stateBlocks.js\":\"7abb9be078088792\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"8a563e9cda52798a\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"88409dbd92a28c84\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"1115891e35c72c32\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"2c6700a06457a1c8\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"f233fd371ea2d9af\",\"/knowledge-medium/src/data/targets.js\":\"c108c448633f6f6e\",\"/knowledge-medium/src/data/typeColors.js\":\"798b637e59836211\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"7ee18ed0897fcef0\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"47e2f389f4dd3e82\",\"/knowledge-medium/src/data/typeExtraction.js\":\"420ff24695c0603c\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"d38cde6262b5ccd9\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"930809145febfa48\",\"/knowledge-medium/src/data/typeSeeds.js\":\"3e78d590753975ce\",\"/knowledge-medium/src/data/typeTagger.js\":\"7a73e387abd5f470\",\"/knowledge-medium/src/data/typedRecords.js\":\"5890b219553caecb\",\"/knowledge-medium/src/data/typesPage.js\":\"493d2e2356e88628\",\"/knowledge-medium/src/data/userPrefs.js\":\"64ae5e6c796a0fb4\",\"/knowledge-medium/src/data/userSchemasService.js\":\"e6ed9c8531eb9587\",\"/knowledge-medium/src/data/userTypesService.js\":\"a9d6b821ad0267ae\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"c39fc8741f735ba3\",\"/knowledge-medium/src/data/visibleChildren.js\":\"6e2aad00a5247b55\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"8ea03b73b7c1c308\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"26101861cc75dd05\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"57f13c13a80cc111\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"e174356be95caab8\",\"/knowledge-medium/src/data/workspaces.js\":\"3ea5a1dd3a4e6dc1\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"17455f3fc7683277\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"d18b689613485a9b\",\"/knowledge-medium/src/editor/atTrigger.js\":\"56c5300231360cfe\",\"/knowledge-medium/src/editor/autocomplete.js\":\"482d77560274f177\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"a7e4d82df2251fe4\",\"/knowledge-medium/src/editor/contentFlush.js\":\"77a51b22b440235a\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"44249a84827e5dab\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"e6f3c8c06258d147\",\"/knowledge-medium/src/editor/insertImage.js\":\"c0b1a6c2d634773b\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"17e84731cdc22893\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"927d8f417f8f0965\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"c8af61137ed55c7c\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"1358e92cb530ae0b\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"87a31efefb4834e5\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"6198b9665c165d02\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"c2d15ba57223d0dc\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"9473e649a066bf05\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"c2a41eac612dbd5f\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"12e0fd7998809010\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"0b136c4cb74c99fa\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"3c218d292defebeb\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"72e8e33360491d58\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"eec24c02f58b8e4d\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"88e5cb002aa3feba\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"d8dee1aa44ae9d51\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"47eeb55a57992755\",\"/knowledge-medium/src/extensions/core.js\":\"f23b27886171e8fc\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"03913fadb01898cb\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"9a2f15b981b1b95f\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"ebfe0b42d3b1dcf1\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"cfa6a3036d2bf833\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"01f46b1f1a04bdc9\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"f5ddc21aca857f68\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"225bcf4459bd1684\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"d43102223480a50b\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"485799b2c042f9c8\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"c085533d06e94630\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"13fa3d29ee3d1e11\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"b2e9b023117a8f20\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"5832fe7d604cc1e2\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"f23fd86adcf28289\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"832e3df31caa3e2b\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"f509d8999e647c3a\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"f961363beea88772\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"3e27b2bf188d5e0d\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"1f198f9424bd808a\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"36e4ba9b27b9430f\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"aba53ca2c4974431\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"e9c689d938150b33\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"6616cc14263c9689\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"5fdf3d0188b2e758\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"afc9579f9262a875\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"57bdfe2c983a25b6\",\"/knowledge-medium/src/facets/facet.js\":\"1a244ee351dc7f71\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"81a8725ef6499e94\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"69774ee5cc0e7bdf\",\"/knowledge-medium/src/facets/togglable.js\":\"9639d99288a04a81\",\"/knowledge-medium/src/facets/variantFacet.js\":\"4a6c0459c97a023c\",\"/knowledge-medium/src/facets/verbFacet.js\":\"37d42ff63639fd9d\",\"/knowledge-medium/src/hooks/block.js\":\"8840442f54795cce\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"127f7fdd7ab92f84\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"1b5ee609b59f99a5\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"cf6b33e42dd34192\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"718bb7543a4ac31d\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"4b304979af2987be\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"302e8c07d1b751ee\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"d53dca0a6f39712f\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"8002c27c33a78043\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"053dbc0c82851235\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"f7dc6ae817bf240f\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"133241d2e637f2fc\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"0e2e407a250a45e2\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"6fbe80b520cd2d2c\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"eb97711a5c31b502\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"94166130d2a91532\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"0780cd55e6adef26\",\"/knowledge-medium/src/lib/utils.js\":\"17f303225296559b\",\"/knowledge-medium/src/main.js\":\"08e534b2c2c48f24\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"0cafdb96b0cf9926\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"421a546cf1a47e69\",\"/knowledge-medium/src/markdown/context.js\":\"3e1275c3281c7083\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"a94da928e0f742e9\",\"/knowledge-medium/src/markdown/extensions.js\":\"b288b7b684af75f7\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"e2dc34e8318f9e77\",\"/knowledge-medium/src/minimal-editor.js\":\"7f545fdd696df732\",\"/knowledge-medium/src/paste/armedCut.js\":\"c917576781a6bfe9\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"eb16a3e608edc314\",\"/knowledge-medium/src/paste/clipboard.js\":\"4a111a190725d6cc\",\"/knowledge-medium/src/paste/decision.js\":\"030e5b09da3c5f3c\",\"/knowledge-medium/src/paste/operations.js\":\"4f497f3105627d44\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"60ae550bfc1b2150\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"9d8d1fb753bf2241\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"e33d46f0f80ca77d\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"91df9bcfa49da8cb\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"f221cb587dc1891f\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"448ac8dd5312fdc6\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"e136553a20926fad\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"3d87c3ceed24d924\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"809c34516911535e\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"386f5185195e32e9\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"2d8f6e201bfe51d3\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"1d599d459467c4e1\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"2e80c437edb415b6\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"2dbdcdbe2e9375ee\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"137ecafaf47fa5fa\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"f528e7b53aa3636a\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"82692d7cef77aba5\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"5dc81c8d2d0655fb\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"1033f35a8ef1a391\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"e9db3bf5c46bcad8\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"c3191b4e2b6536f1\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"4aee372f90f51f3f\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"2f81c85f00921d6d\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"5d1e83687d9e3464\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"44bec8db007309a5\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"e15d1d7f5da17147\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"bb877a513a509c1b\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"fa0b82311c414247\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"afebd94cc9f09306\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"a277178e0192e149\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"4cead62c52b97320\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"0039eaa7fbd2875a\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"8624072b101d076e\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"be47abaff240736d\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"15897381de69e986\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"8ce12d67420d3b3e\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"b8daf858e0e09e57\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"f23cd95e88a2d728\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"3c3fbf5f694bc8a7\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"cbc5182ecab17a63\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"5c8792d18fababf3\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"533d763c26a5a807\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"8abcce6375ab6fe8\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"24c80bd0fabeeac1\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"92c540fa496ba434\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"6a9a2bf9ce448d79\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"6592ac0f9d011243\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"0bcf91320ff7a434\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"db0a63fa5a553b2c\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"db5ba42a2683cc50\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"6162edd5f4d19f9a\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"49d811ab8214b685\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"5b832958aa086362\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"7bb37ef3c494fdd6\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"64214aae73cc8395\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"89fa628bfd666874\",\"/knowledge-medium/src/plugins/alias/index.js\":\"c6d219953a7d51e9\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"d3a6bc552e44cf6b\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"709daff5a26d585d\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"5b08aaa0b69a8f66\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"14c60adaf5be9116\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"15efb50678af2ec3\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"fb8652accbaf1576\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"dd2064b0ae888b8f\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"815f089d91be0b01\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"6ad2ecaa5a4a174e\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"3fe450888933a0a2\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"8e7fde77bb65f724\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"246e67f4afa2b878\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"7f94f57d62cf2968\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"a7e3126d65abf9c7\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"5cc0aba1df6b4222\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"013933833b33d30d\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"a08f86006600c85e\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"70a3687d11a1ee75\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"005556a282ff04bc\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"34f85b5cdeb03390\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"b13e2fd8bd2d36dc\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"8bb2d53fd12b8f1c\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"bcdc8f4ae055799c\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"2533ab644cea39ba\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"1cee13de7d1d3bb3\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"b10d1d7d139b681a\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"ca1a8f6ef81df2d1\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"cd394d3af087b112\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"a166a042bbd866ba\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"225df56ba50c57d5\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"30caa99023dfabf3\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"c18111da2cdb20b8\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"56fb70bdf836b5ce\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"9857fc6df021edeb\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"6c650d569be6ab46\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"5a1e57a70c67d823\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"d01ce98941e27122\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"bc7a564cef550eb9\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"7eefaf45bb42d53e\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"8ecc37d520a6910b\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"6a212b8f10c737c5\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"d8bcd977a005b241\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"8fa237240386e4a5\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"06d683dd257c7051\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"7d84d495764ee48b\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"e72045369735acfa\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"a4e23e6da05ac5cc\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"f690749f26f71631\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"f49dcf2f53d4727b\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"29d325dbf1befe4c\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"6f02898ba27f40a8\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"98e87da2f17c06f9\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"a755b058f47a6141\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"c4a63f63a1116229\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"68da0ebe14bde582\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"3ecd02587dc525c6\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"87d696cdfc22de30\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"40ad8d7433a6e538\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"5804dca518172316\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"b740ac0c9ea6cae2\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"d704ec52c2c08068\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"e440b0dc07852c29\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"2c18c46d44069d43\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"88eb61bd10855526\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"c5f72b38f6fc9f17\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"01b099d338ade30a\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"541c29d8b249a573\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"d4795b1a16db6974\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"a0ffd9f0fef0ad2a\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"b5c2c41f9646d32f\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"1b6a661dec8a09b7\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"3bd36a8bb4290f7e\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"7b7959ce2c73f378\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"892ede332f74fdbe\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"dc450d665ef83a03\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"17db231113896c44\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"4b47a318feded78f\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"b3834f6edb3a30a0\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"ca7ccd5e6b65182f\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"fc438372a0197079\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"bec63652de02bdc7\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"170973fe65eb1c22\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"f2f8342c7881e513\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"da13b692c8e5b957\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"1c51cb9492542bff\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"08d4a9f1d1c9cf26\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"7bbd67d4f30e9bcc\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"78bd82c28170a51b\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"1f37e6985c6e662c\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"c74d4f5bee3e3095\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"e087ebfb226d15ad\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"6ace14fe10f24218\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"74bc166d7e16ba25\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"27def3d1ec0a1544\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"1df3dbf4e6a45c39\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"bc6c399a3d5142a1\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"fc8d931417de97e3\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"fcf7d58b207ce010\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"9f8cccf3f9377552\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"eabf3aeb1182c204\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"0bc0ed704b4c0b34\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"fcdc82f63a635d10\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"40a8225365010a40\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"0b3c6f0bffff4e8e\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"421f332c6a1ead43\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"515b3238f14d90b5\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"71cd8fb163ad3f3d\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"31cf18e74b024a9f\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"3bae21f074a8d749\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"2c795e5180708d1d\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"2b9c107f81eea095\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"0d62695875612b5b\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"90e6eedb8e4eb567\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"17336ea7154859d1\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"e647915981000342\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"233dc34b5075ba9a\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"9ba3d6438f04bca7\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"48a35cc05e7974a1\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"b4b2b0894b622df9\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"75b879158539bb34\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"ef3eea8fcba9655a\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"138e169b3d53b914\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"f32bf0e59ac338b0\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"44efbe096843de8e\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"d70f1b5146f40d81\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"2a0f8d50886e7e99\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"8257b7f5237fc482\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"9829fc3e5016f0e7\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"3bad713b3c255779\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"87439975e9f54829\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"f3128927021d4589\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"dd2de4a284e02b00\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"6f0db16e55b31201\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"e4ba8b827a48c039\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"b70bae7c58576b26\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"863198a4815905ca\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"a5c78cf0c3f1acc5\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"28431badc97ae5e1\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"2b38d824d5c9839f\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"d4f0dda7907dfe4a\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"fc1cd46aa7fca35e\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"5c83047154679621\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"d349701e32a526c6\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"f81004722e0b237c\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"d30de6f755163151\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"2c9a740609002b40\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"e2a744cfa4772441\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"fd16c0d06a9f3a75\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"601974e7d17f63cb\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"9c528f8ba82f1f59\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"83ada5fbd8843820\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"f8a5a26134bca3f5\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"ba87ae8640bcc289\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"74c45fbbf1a0e817\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"ae5da7a7b160da30\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"9e79ad46d7100f27\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"aae1a04564711426\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"4cca601bb9611606\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"9a73cc87f8089dde\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"8510d837d29bef16\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"15b67717de41270e\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"6e81e8d334b7b35a\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"d72ae623d5b16d23\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"0c78fb661377ba18\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"7d66e2a0fef13a11\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"a87bb32839e21193\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"e0877d1e92043b94\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"2076f02b515f95f2\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"769daa07795c3536\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"2315509985d36370\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"0d890f6b81de5cc8\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"923f612cc98624cd\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"062a71fead45bd56\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"78103d0e1a8a315d\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"c3e2a5c2608629da\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"2c26598a3c6fa40f\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"03f3a9aaf8445b61\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"90f278136cdc2654\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"d8293b4251b713ed\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"1d50401a7872f9fb\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"56547bc6711c368b\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"ae2164a1179848e6\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"0c802ffb2f63d972\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"b6f7db1ef7e35066\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"6c58520648fa5d4f\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"e27d2bb346eb755a\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"0b2c61a78a065607\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"48749e5418064f9d\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"338a7f8cd26081d9\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"8cba6d0246521a1e\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"c0b8a028772376f9\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"2b505a868352e06b\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"7e6a944d73d06653\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"829332038f560415\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"ef0f08a72e14ace0\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"86a616e716537504\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"05469f2962108458\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"9dd4d96bacae0131\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"a5263ae6bd513b19\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"527da4e6e82da652\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"9b16d8601366a226\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"d5075d811e3467d6\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"3cb7e60134391c3d\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"373436ac0a8ec035\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"6bd16e70b18fcff5\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"d9264ea864d62121\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"1cff9f47ed7784c9\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"53cfb480ffb9fe17\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"03da2fc4e913a1e2\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"2c96a0058eebbcc2\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"e53e362c2adbebcd\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"03a6d70b5076c143\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"05725cf797b89262\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"7e39fd82b97180cf\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"b28f15641ac3cab2\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"41fd782e6983b6e6\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"6930fbd28e9b9302\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"e2be2051f63a27e9\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"d845c4e96f2de966\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"5440056c88945494\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"a9006191de456e13\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"4071f9466ab7dc5f\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"8f6c5470e9b5e448\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"aba99dabe6e45d73\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"98f194597d632267\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"48d3a72b0b7928c6\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"d3fc1897ec1fa8d5\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"15760c7e9e9d379b\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"c38a3a70dbb9cbb4\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"d2708df34ca4573b\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"1305374f0b842789\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"3e08f9a5223831b8\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"50a546af8b54f728\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"923e9a47b21c0c37\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"fe0000cfce4bf71f\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"98361106ea5c5c5f\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"ad1bcb6553c53fb5\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"7b37a15cc2d35ac4\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"bda588926718ebea\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"54285174eae81107\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"e93cd53f8c6ee10e\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"7b5e3dba3e94fef0\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"bba1085499d116cf\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"78e18291b86aa00e\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"0177bf597ff0418f\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"22757df0f102570a\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"1bb4e6b122e29e6b\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"8d7d0363e44e68fe\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"09570e29b97f7665\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"3f904e17d87f9d86\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"d5976f29cca4295e\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"d883ee299a043853\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"185a3487447b38be\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"e4851993a098e120\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"66c40cb924b14e41\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"5f1a016fb8a9e3f6\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"a3ac2973aa3c2951\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"af5a9f0992c53af5\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"095afa19436b8ccc\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"086719688c029a52\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"0ea35f4c5b0ea7db\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"3ce5fc0a58b8cb6f\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"4aef9f79948291f1\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"599270c8c57e2def\",\"/knowledge-medium/src/plugins/geo/index.js\":\"dbeb516c60a31940\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"6bf21a9b52e0a2a2\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"779e4213aa275e7e\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"3a72bf1b37c995cf\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"ed8a08b78e678bc5\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"44100617d19fd5da\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"0d94f673a34f6c23\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"788afb95d26c8159\",\"/knowledge-medium/src/plugins/geo/query.js\":\"095084747d99f169\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"f02b1d3c51457773\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"1fbe4c575760acb1\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"7d92fb3a1d05f221\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"8e27b1cd80f21799\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"163a5cf3df7a69ef\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"a1b4b50a71031355\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"8d3f40d302e6de1b\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"6c07bf4dab70f85a\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"a616d87fb389df23\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"01d0a95959b84b57\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"3cde714fa7c71c6c\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"2f6fa0561ccd7c7a\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"4588e3681a271ca9\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"383dbbc2e4197b72\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"93864154d420dd86\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"b82f1f534ec0ed43\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"37860bc6495a8793\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"95af06e2da337450\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"7d9a6ba52d000947\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"166b71462a12b657\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"d810d94f710afe74\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"773fa737669fdcbd\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"f45234a26ee8dd1b\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"b810d28f9ff668c2\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"105f7528cdea1129\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"55d755cf7799a88d\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"3dc1d12f2be53bd0\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"e7613a00d18b5530\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"d39c351f241154ab\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"7e94313204e36fad\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"d2f60ef0eafe1386\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"ec1894da2d4b99d6\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"6310d06053f58cc9\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"691c4f640a8e933e\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"b7b404ac30410ca4\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"35a159dd0a988d24\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"599a2f51561e07ed\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"994af935d91580ab\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"d15bbfa3b60eecf0\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"3a61768ede629693\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"9f5375a362b839ba\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"e9effe6a0c1d21b0\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"a3e26daeab58d87b\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"def8ac084f87a060\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"d61ca41b420098f2\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"9b9e2aa699645105\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"5b0589bae118b13c\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"233a6116ce8ed172\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"6b2b66524a463ba0\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"c6218221e73d9d7b\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"027f7ace28fe1d28\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"445b18454d3b5712\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"d09fdb8f03bafa27\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"635f151f24a309eb\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"7f6ee2abec25ce65\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"4f8914a945ccad24\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"64a140e3751a593c\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"d9e9ebb8423aee61\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"9c98e44417eeb99c\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"e633ea5db6b00cc8\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"46c6cba626048383\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"27e8730736d30486\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"73cef759a5c247c9\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"cbbcdb62d4a8bcbe\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"80f65e7eedc47643\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"7d97f9feaeff325e\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"55b1bf5b5bf5043a\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"3b02a2798c3e325a\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"f2f84cfe73877585\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"5287fd2d89121577\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"a777e27e7cb42e68\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"b645d2331a93d668\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"a6d15e75965637a1\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"5a4afbfd21c0963c\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"9aaaeba14bf25292\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"6e5df3af431944aa\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"a7dd7add8f62f0a8\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"9fa446d27afdf5cf\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"43ece3c22bc61bef\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"affdc62512eeef8c\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"593ca806bd4c1afd\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"141c3603943652b9\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"59c4e677dead9913\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"c32c766eb24a8142\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"8e7eccf558551358\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"a0f52636daf84076\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"fd4acb9c68fd31bc\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"c35c034caa5cda92\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"0186f7f55660a913\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"6ae4b7473194312d\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"8412bb56e9a782a9\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"3f1020ba67551ad1\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"877833c4c03a2824\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"31a1a9a04f144148\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"98bc88da2de1b741\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"6ee44b7d8c506130\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"558292306e19cfef\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"0bba7e4b53917dc9\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"ff85e194c16abbfa\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"5b6fb8fab3d4ae4d\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"8bc390ecb63186a8\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"8d3b4449d81e5bc5\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"f7b662ca82e175f9\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"fb941c517d6306de\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"2a056a0ad0b1b57b\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"8a294c12f73dc7ba\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"4e147bf079e0c95d\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"e2b73003c9976038\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"b957caaa31702556\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"025f87589a5bfafb\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"c75124db485d4643\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"f12f215ef579cc50\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"2583b88e5152c647\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"c3e7eb99ac42a71f\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"591ba68df0aecf8a\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"bc9901bd7f3739f5\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"acd5e73e58f9a51c\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"437a0b3f72de2a61\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"eb6e530325e2f36f\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"6b8a674b3f633018\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"913ca1a8bfa12040\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"b4639997698a934c\",\"/knowledge-medium/src/plugins/recents/index.js\":\"85c4974062a6f4e2\",\"/knowledge-medium/src/plugins/recents/target.js\":\"fc6c6f5cfaac1198\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"90aea671f1d4609e\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"0a604e3a9c4aede8\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"0c989e963c44e650\",\"/knowledge-medium/src/plugins/references/index.js\":\"aa5dd3ad744ff68f\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"2830015c365d8e14\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"fa7515a6cb8d6f51\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"2df663dc151fb2dd\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"1a9d247d8547d899\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"732365da637ff0f1\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"c409ffbbe90467ae\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"ba13c691c08353ef\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"626e0566a7d206da\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"deda062f7d8c72d4\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"2e915d9846e204cf\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"5f8fed97ac780557\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"6dca134527ff6277\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"8dde2c747e82fcc9\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"87583e71e37b4db3\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"e70c904fbf2c2ebd\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"ec2fa8404c095e27\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"294fcdc1b436ed03\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"757cf9458143c072\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"bb8fe93f4a75038d\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"878539fad08453d7\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"54337db3cbdb7498\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"3ccbff05dec8ad56\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"fab4b70091e200ea\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"ab8206d8a655219e\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"a545431d017d9120\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"e44d1bed2cc91a64\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"d3ac71523c64fa61\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"7858a9c41cd4af95\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"b3bc77db36b72a1d\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"2098c948c6af5316\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"326a7476e941895d\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"a956e93f923d7ba7\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"b9f7908a67d999e2\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"dfcd08fd302a4399\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"36baf8f9412caace\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"6eb2299b4f33ec04\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"f8e5ff5e6a638677\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"5e4a4036ba0b6fa9\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"731788c11b533c5f\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"9184b0dd743d2cdd\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"018b869555581661\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"1b555dfff361323b\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"7df4128a2fe07461\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"0964a1e9e270174e\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"14f32bff0444efe4\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"fcfd2eb7640dd529\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"270becbc805d6432\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"fac8853df81752c2\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"9c1d6581aff69bae\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"6cfde26be245cf8b\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"beaa5896d3976b90\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"340120af3cb13e40\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"1f08a6fc322227ae\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"b64577ff75174fce\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"fb81ea8594eb4a11\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"c3577bf727f45a15\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"d2c8786b52b08e48\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"47617d91a17a9a82\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"a94625dae779371c\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"fc5e504bb9b09d97\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"c78aaf59c31178c5\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"448e03be726f7372\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"bba58018df150b52\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"b19b87264ad28b55\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"ad7c1fd8a83ca676\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"9462e8acf82b9917\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"e48887d09aa4ff3a\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"3ed95ec76d056ad2\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"81d613711b5957b3\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"a29fec02aaf7f501\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"0ac1389f433a758e\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"270fc8c522bd4cdf\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"3071a87cd58e490f\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"3a49355d60f38613\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"ebaad4d3e617ecb1\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"955cdb902ea630fd\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"bfb2bb964aae3b38\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"5ebc1bb5a3bf4475\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"f9c22e83cec80c83\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"3ddf9f1db90563eb\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"7fa72a52679877b8\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"c2e56a6a9059afe2\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"073852feb32ce528\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"539356a5bb44298f\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"20fb18f0f9ebf75d\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"fe42b84b1355a7eb\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"c8e8b824a3fa6e4b\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"efc66ee0c0e7bd22\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"dc8fc50e7fd2a690\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"61241c8673e634d6\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"ba561b226deea2f7\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"4fdaa92b17b3a1a4\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"00cc5ae10a9f5533\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"41e2c1d4dbdd05cf\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"177b8426efc6c500\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"cc17d7f052279c81\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"ec60dcf63aaba417\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"78e1c019558f757d\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"d7d1e6620d641e87\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"61623faa73a4a2ea\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"7572dd7041928879\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"5a92eae5b69b56c2\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"f07199d0394edfba\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"dab89f92701c4399\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"d8a4b97fbf5e4cd4\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"2383807dea31bde3\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"b94e101830be6a23\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"2dd9b4e9d1237c48\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"31c729476659d278\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"3d228288d8876d64\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"90615ab9d6d2e361\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"40dedfccbd23db5b\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"68f910ec0055d4a4\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"2f233ddc2caa0194\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"584d4266deb34f4a\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"ea5c01464bb6eac4\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"d1d5d87517b06c3b\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"05c282916168f2ee\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"6d3becf33cf4249b\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"aaae0d2f6f6d7f42\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"8f931f0b44305b65\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"6c899dd744fb49e8\",\"/knowledge-medium/src/plugins/tables/index.js\":\"a0136f83e1d64e76\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"9420915a5e181068\",\"/knowledge-medium/src/plugins/tables/model.js\":\"5c5ac4174c094047\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"21f633e7fd852d95\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"ac006e0669a61f45\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"981c0c7a7432bce3\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"6bb873610826d3c9\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"b9550c6e403f3565\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"6ff50e7ade63ed02\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"85583883d9bea016\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"487fe662e0ea15dc\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"8c4c9acdd3543dab\",\"/knowledge-medium/src/plugins/todo/index.js\":\"9d9ea1508b53a8ac\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"c60e0f1ed76f32fa\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"b074233b85df2484\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"fd1b888a02553585\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"7b363884d0f431b1\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"dce91dd995f5a5d8\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"c3c851a4f4057691\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"fb5e417f915545fe\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"114ca5ffd94e44c7\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"0148c01ff8da9654\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"787af7c7b86d2f7b\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"44407c7c2aa16549\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"af82e45ea3ab9524\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"4633697ab4f4f3b4\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"1bb045094d4ebc6e\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"c605f22be55c1543\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"06345afbaddabdcf\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"a76c6f63347af9ad\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"f21ff3955dad61d8\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"e6c478004511d3e4\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"b94cd7863366ce13\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"acc26367dce38934\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"b6fbe761e0a91572\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"858762797fbfc690\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"54874fa25f9b188d\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"cd2e4bf7800a9d93\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"4ef3e7425deb887a\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"ced25784b2340331\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"e9409a4a43c6d8c3\",\"/knowledge-medium/src/registerServiceWorker.js\":\"484e614b37e92482\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"e1eacabbad041d10\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"058bb1c7a757f9ee\",\"/knowledge-medium/src/services/authStorage.js\":\"13776ccce2d2c8ff\",\"/knowledge-medium/src/services/powersync.js\":\"b10c79c52b23ca33\",\"/knowledge-medium/src/services/supabase.js\":\"b1f0ae30f1948c7f\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"31e6ba7e7b4ce4f9\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"7c7a91c6bfb1fab5\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"12e6fa0dc880cd0b\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"1f158924b7e0ef7a\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"995da075888a29d0\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"1cc345a1414ac7f0\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"bdc294a9049616b1\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"5b13e4542876882d\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"cc2a128cb8b1dba5\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"e20be8073539bf6e\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"0b396bfe0829f821\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"c58a3189b12f96cf\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"14b97d2e09ccceab\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"ca981022231f759a\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"6a1bcd48df4b8c9c\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"46ba40773e2c05b2\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"62ca00ad5b80e864\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"41ad76f83fc885e5\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"99ebe2db3bcc3230\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"0b43bf054e8d842e\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"c38a1a04644f543e\",\"/knowledge-medium/src/shortcuts/types.js\":\"0a96d6a74ed9474b\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"876ef39502cf5e49\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"7dd2e5e780725449\",\"/knowledge-medium/src/shortcuts/utils.js\":\"312ff96c54468092\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"b77928d9ea731bca\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"c203ee10ceab2e65\",\"/knowledge-medium/src/sync/byteTransform.js\":\"c538f2f521e3073c\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"4a4db54c9945ebca\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"bba1f454b6798ed2\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"3e4820c2812a6490\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"aaedb6845de57418\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"c7f535793a3aaa91\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"cfb2345c8a5987ec\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"313fab0d7004fafb\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"bdaa8e7d206ad0d1\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"0582eb777437fcc4\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"f9f0d50b444a76ac\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"ce6acff78ef49d77\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"c87d28ba64ffac20\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"e1c3476e46f49a71\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"4c4d05b11ede094e\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"a5e88a066888f369\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"fc2b22e5ad14ed49\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"3469a53f3fcc3dd3\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"b329c2f9c0ff9788\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"48ab197c1f553af3\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"8ba2197deb69f8e6\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"b0f21b40548503bc\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"5a6df898b58cd7e2\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"96b2e4f88d7e6b01\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"49729a90f5af668c\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"b51db5755026d941\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"074fd5a2a1351c99\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"1cf3dec52e22a224\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"a2ef608279eec5a9\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"43b1800130382465\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"148790152e283bca\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"5ced8a28f4768fb6\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"39b59fbb6f4ef1e9\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"2b39e1796127b5cd\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"a9e20968246843e6\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"c425d90f1d12063b\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"d83fee64b519d1ff\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"18289f574969eaf1\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"c8bb922c896ceae9\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"63e057a3590c303c\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"710e031ee92cef07\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"cea5235d1abba6ff\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"ebdf119dc83fd0b7\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"6b8fd546c51fff26\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"801d2730c921168a\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"ca44b0b6b1346b61\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"031b3129dbdcb144\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"a81ccb521e0b4ccc\",\"/knowledge-medium/src/sync/transform.js\":\"a94cfc1c7f13e9a0\",\"/knowledge-medium/src/themeBootDefaults.js\":\"acbba5e5fabd6f97\",\"/knowledge-medium/src/types.js\":\"ea67bb2633776e9e\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"11124f5f5245e108\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"5142cc106898778d\",\"/knowledge-medium/src/utils/array.js\":\"acc4fcf1d9e7b6a0\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"c5219d1eb490258b\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"8f551fc99f7077e2\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"10ae6c91844bc837\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"38665ceaefe209ac\",\"/knowledge-medium/src/utils/callbackSet.js\":\"80573bd2110d3145\",\"/knowledge-medium/src/utils/clientId.js\":\"f0259810b03ebffa\",\"/knowledge-medium/src/utils/codemirror.js\":\"fc8e6cc6ff12a14b\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"d39f8f4b71aa50d5\",\"/knowledge-medium/src/utils/copy.js\":\"4704b448989202b0\",\"/knowledge-medium/src/utils/dailyPage.js\":\"3bea80980281fd8e\",\"/knowledge-medium/src/utils/dbForensics.js\":\"f3e2d820b519edff\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"a14d98540489a64f\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"3afc18b834c0e51d\",\"/knowledge-medium/src/utils/dialogs.js\":\"f58dbb874d622fb7\",\"/knowledge-medium/src/utils/dom.js\":\"702309e08d189fbc\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"f4c28c69a8feeb92\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"5b0b41d74fc9f5ca\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"c4dc99487d55331b\",\"/knowledge-medium/src/utils/flipSlide.js\":\"299f8a1b8518f62d\",\"/knowledge-medium/src/utils/fnv1a.js\":\"7f2af57d213c1eff\",\"/knowledge-medium/src/utils/formatBytes.js\":\"287c6b83ae0bcd3e\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"23c97e29c4be54c3\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"a2246396564dc2ed\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"8725ec860463f71b\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"f28d87ccdd43a456\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"fbcdfab1054b1f1c\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"86dbe12f9b36173a\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"2496332c7334cb62\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"42c5df6cc77e9a78\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"537d93f8166c3457\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"8ddacce06b7fa1f3\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"1e33a497b7fd89ae\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"47e5e7dd5499e488\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"b8c5b0c8071f7a38\",\"/knowledge-medium/src/utils/markdownParser.js\":\"5d77ee529671cbec\",\"/knowledge-medium/src/utils/memoize.js\":\"ec39a24b388d0fbd\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"344e27b28c485cad\",\"/knowledge-medium/src/utils/nameList.js\":\"d0b9d869286d58f9\",\"/knowledge-medium/src/utils/navigation.js\":\"d608371767a0ffc8\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"d8d7b28be5f83f0c\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"ca070611927cfeef\",\"/knowledge-medium/src/utils/panelClearance.js\":\"5b77f6448607b083\",\"/knowledge-medium/src/utils/panelHistory.js\":\"761f6c085810e793\",\"/knowledge-medium/src/utils/panelLanes.js\":\"e93dfbfed3b03d4a\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"c4ec3d68d9f4ece4\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"4c5f48a37df49579\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"cc08896facb20bcc\",\"/knowledge-medium/src/utils/platform.js\":\"ecf206dcb84586b6\",\"/knowledge-medium/src/utils/pluralize.js\":\"3e52b0bb7e5dc85b\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"6e3231a4fe921130\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"d4a61cbc09eaca72\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"cba9f638d113536a\",\"/knowledge-medium/src/utils/react.js\":\"c42c222f508cca30\",\"/knowledge-medium/src/utils/relativeDate.js\":\"4478964718dbc247\",\"/knowledge-medium/src/utils/relativeTime.js\":\"6b1b61e6dab6dc48\",\"/knowledge-medium/src/utils/renderScope.js\":\"cfc61424abc05258\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"31328e4291ff0947\",\"/knowledge-medium/src/utils/routing.js\":\"79d0eb3f3974edec\",\"/knowledge-medium/src/utils/safeMode.js\":\"44f179029bef3a0c\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"85c3f80b3c5943dd\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"bd9f8b9bcc6b1862\",\"/knowledge-medium/src/utils/selection.js\":\"ed4d79160b0f77e2\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"0a417be6fd4cc57d\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"766490ddc0db4d58\",\"/knowledge-medium/src/utils/state.js\":\"dab9b52823b5363d\",\"/knowledge-medium/src/utils/string.js\":\"e5e9eef0cde366a0\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"03aeb144ff51575d\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"9580824529510c59\",\"/knowledge-medium/src/utils/toast.js\":\"fabf3a600025d027\",\"/knowledge-medium/src/utils/toggleStore.js\":\"afd9df01b73cabf0\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"6d14aaac9e545995\",\"/knowledge-medium/src/utils/userActivity.js\":\"7e59179f35991621\",\"/knowledge-medium/src/utils/viewTransition.js\":\"860c40fb0155951c\",\"/knowledge-medium/src/utils/viewport.js\":\"729a1a996803b1b6\",\"/knowledge-medium/src/utils/webLock.js\":\"bbeddc9a2b8d4214\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"26e65d7def604a3b\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"6be235b7bef87edb\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"b37fd56921c6882d\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"4efa2e39d3d80539\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"a83e7cd727b84aeb\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"7bc7af708779c809\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"9c7296a5a240b535\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"8c10a2be9f07c110\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"1249c816485f1ca7\",\"/knowledge-medium/src/vendor/react-dom.js\":\"c685e7a33984105a\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"908b42a97e75fc5d\",\"/knowledge-medium/src/vendor/react.js\":\"ae2a16b8ddb65f09\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
