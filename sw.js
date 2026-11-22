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
		buildId: "a14a45fc0bb7-51cd6ba2",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"4d8c8cd21a74ca69\",\"/knowledge-medium/index.html\":\"4d8c8cd21a74ca69\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-FBYlNW-N.js\":\"e95abdafebc94183\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"de2eee0d00ab051d\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-DrrY7Ko3.js\":\"0462d93acf436e11\",\"/knowledge-medium/chunks/FacadeVFS-BwstxVI9.js\":\"d2114e725d00e2db\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-C4qmTraJ.js\":\"db13b4113963afb1\",\"/knowledge-medium/chunks/MemoryVFS-DtPSfEbW.js\":\"ee0b31ac201fe4c5\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-C8hcQt86.js\":\"1a425c5bbb79c14e\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-QVYrM5uu.js\":\"475072e50aba1d37\",\"/knowledge-medium/chunks/Preview-Dch_Cs5z.js\":\"72a53bd2592c6400\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-DEFb-6DJ.js\":\"f8d7f9a2cb064490\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-CBjOdz0X.js\":\"89e1b819ee8a650d\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-B-r2kVL_.js\":\"1602cb82fe8cb826\",\"/knowledge-medium/chunks/react-BuuHJjQa.js\":\"2eb5924f472b6aea\",\"/knowledge-medium/chunks/react-D-_6IneM.js\":\"c8746103922a2118\",\"/knowledge-medium/chunks/react-DHYh0A8c.js\":\"9c99461c8ec8e425\",\"/knowledge-medium/chunks/react-DkyKW4El.js\":\"f59eba09fe179817\",\"/knowledge-medium/chunks/react-Sy9rEpTK.js\":\"6ccb8e6af6ce51d5\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-DOhSaLW-.js\":\"6f82caf2cab93e24\",\"/knowledge-medium/chunks/react-dom-server.browser.production-CVls6TOn.js\":\"69c39a711b01ef77\",\"/knowledge-medium/chunks/react-dom-server.edge.production-B0tdaryZ.js\":\"683a290a1bed5e35\",\"/knowledge-medium/chunks/react-eSF-O1e8.js\":\"d292531f0296d2b8\",\"/knowledge-medium/chunks/react-ez5Xlo1R.js\":\"4785bb638762b0b9\",\"/knowledge-medium/chunks/server.browser-DYFFLJk-.js\":\"a2c6e834eaac1e20\",\"/knowledge-medium/chunks/textarea-uczujAxx.js\":\"62876fe22359b790\",\"/knowledge-medium/chunks/ui-QvFkM5Tc.js\":\"08cc0c0b5c62a3f4\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"e52ae2911ba3aa14\",\"/knowledge-medium/src/appUpdate.js\":\"3dc42f4ea4cb09e9\",\"/knowledge-medium/src/appVersion.js\":\"6c773fa9e1945de6\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"d323dec1a303fa00\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"5bcc12c7daf0ee06\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"73b326aa68e48e19\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"0a98ae831da9ace4\",\"/knowledge-medium/src/components/BlockComponent.js\":\"ab6a71b4145ff480\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"583d1b38b0a8c47d\",\"/knowledge-medium/src/components/BlockEditor.js\":\"3cb56f47a50108f9\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"2b1be89c0d0fe7de\",\"/knowledge-medium/src/components/BlockProperties.js\":\"1934e64530915cdc\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"5a39c85ad17db88f\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"1d82eea2106d530f\",\"/knowledge-medium/src/components/DividerHandle.js\":\"114feb1ea870b159\",\"/knowledge-medium/src/components/DraftEditor.js\":\"b0bfc9608c1c1623\",\"/knowledge-medium/src/components/GutterPill.js\":\"8bee1a6f1e845b83\",\"/knowledge-medium/src/components/Header.js\":\"bf7cdff6ae4b7a7b\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"62932c67a4bbfbd8\",\"/knowledge-medium/src/components/Login.js\":\"e3075c90cf026cd1\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"ea689bbfaeea9d8b\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"fe549dd9ff5c5e41\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"0c8fcd7d2e09bc1b\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"ca37892ff4cb7029\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"6498b2a3430499d6\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"97eb788ddcc11995\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"9c4ea2d764a933bc\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"e4ee8e1a1de7bb77\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"ce48fac473ed5931\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"45024d3a6b50a3f4\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"05be09c176508b61\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"a23dad88085fcbd7\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"7d7a0f746646eb0e\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"59f4a67abd53ffad\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"78e7c12a293a4e5b\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"2be4474c2fa85f00\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"c0e4169c3f5a64b5\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"31bf41c65b2c2e3a\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"8ad351f2805a16f2\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"1aa784cfb01c434c\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"67c1828974466587\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"ec887ae437def1ea\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"9f33e6f29c1f9f45\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"f12f1f7cc9e5a2e2\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"24a9e653b83e7940\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"b3bc79a5e24860bc\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"90f006f6ecd6c4f6\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"17ce4ef568b2168b\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"7095bc152680995c\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"69f447c01d729c11\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"40a0bb882f65b3ac\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"f998b8fa41921554\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"4760a6ec6f96bac6\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"2dba7352d9296cc1\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"f8c58053a5a49ec1\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"0edfba6c9333448b\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"2e5992cbe2685d62\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"e1edc047b431bac7\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"75cd8ecc1f929442\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"099e813dde9d0e55\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"675b7b021d1a1bf7\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"a0a70da84e9d3122\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"0562fc499a82f055\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"b3fd57d26058a5f3\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"ce9abcd5da34709a\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"f252e38dff713345\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"258ce7eda8d3b904\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"7eaeea773bf159c3\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"395c1ef9a8e4680d\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"96187191f1918d83\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"6de778e779a9adc0\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"c9b08e0409ee8e26\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"e10b61acb1df8796\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"9d1739743e7a17eb\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"da1a2e6ff9d1672d\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"645eb5d0ece91ad1\",\"/knowledge-medium/src/components/ui/button.js\":\"305a2f5f3c527b67\",\"/knowledge-medium/src/components/ui/card.js\":\"612d460828dec8d0\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"400b9832cae1cc7f\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"13b5fd329e389804\",\"/knowledge-medium/src/components/ui/command.js\":\"13994d65a3d10bbe\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"d85700beeaca6929\",\"/knowledge-medium/src/components/ui/dialog.js\":\"5cc03caacdd86dd5\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"fb78b4f80da83b79\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"4b2b6e0ca947c84e\",\"/knowledge-medium/src/components/ui/index.js\":\"878d18497344eda3\",\"/knowledge-medium/src/components/ui/input.js\":\"4520525ac77ce04d\",\"/knowledge-medium/src/components/ui/kbd.js\":\"e7a4ac5f15f2c95a\",\"/knowledge-medium/src/components/ui/label.js\":\"0c5875b7d219a53f\",\"/knowledge-medium/src/components/ui/textarea.js\":\"82352c19017e834f\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"5e1ca1316d997ab7\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"0348a56f9bef0619\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"c1bd5e160d723748\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"e87ebb13ec2cfaeb\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"5e1cd949d7d1aaf6\",\"/knowledge-medium/src/components/util/error.js\":\"74f59bd10b85ca66\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"c11a33594897cf92\",\"/knowledge-medium/src/components/util/suspense.js\":\"60d8d8f6277dc15e\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"0a71a72c1b32ca71\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"f8f48bde41bc123d\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"0472059dc893d6cb\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"74894c33e61a8706\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"5e8d38bafa7e8eb1\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"2d689c3a690bf0ab\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"9671c7d50e544e4e\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"4e6d644a7a8f6c8b\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"7f1967837be0a4cd\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"62aa09cff2400ba2\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"eb861fe905c435a7\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"4d0f0f8a27d11343\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"d6e19f5d733a41d1\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"9929ceb7dba903f5\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"8d0541e2354b227d\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"b1d3fdb74cb41822\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"45bb4196587a918a\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"7adbf37fc9ffa77f\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"28e8c4eb14b961a7\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"bb3fdf9bdedc6c37\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"922d85d343f87195\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"515c99efdb690fc4\",\"/knowledge-medium/src/context/block.js\":\"eefd71abc7841380\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"53b11b88ad72df50\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"14e8f3082c0cacff\",\"/knowledge-medium/src/context/repo.js\":\"793619c91e464c55\",\"/knowledge-medium/src/data/aliasClaim.js\":\"95e096cbe5222295\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"d3d145b62da49cc2\",\"/knowledge-medium/src/data/api/blockData.js\":\"4f8032e2172f8fea\",\"/knowledge-medium/src/data/api/blockType.js\":\"e5ad06811d3b8476\",\"/knowledge-medium/src/data/api/changeScope.js\":\"418e6ff46f24036e\",\"/knowledge-medium/src/data/api/codecs.js\":\"aa2423deede3b0cf\",\"/knowledge-medium/src/data/api/derivedData.js\":\"f82271a00db73dc7\",\"/knowledge-medium/src/data/api/errors.js\":\"23a22f59c2612ebc\",\"/knowledge-medium/src/data/api/events.js\":\"dcc0d06ebb735aa0\",\"/knowledge-medium/src/data/api/handle.js\":\"05fdb939ccf05da1\",\"/knowledge-medium/src/data/api/index.js\":\"a2efa86c19cdd4af\",\"/knowledge-medium/src/data/api/mutator.js\":\"04d8f86ef5673436\",\"/knowledge-medium/src/data/api/processor.js\":\"c517b3f352950224\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"1b1cc30d3857d662\",\"/knowledge-medium/src/data/api/query.js\":\"b1882905afbe9aed\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"1c91a800340cb561\",\"/knowledge-medium/src/data/api/schema.js\":\"05fdb939ccf05da1\",\"/knowledge-medium/src/data/api/tx.js\":\"05fdb939ccf05da1\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"d3e3807da67192ec\",\"/knowledge-medium/src/data/api/user.js\":\"7e94d7a641dfff17\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"6fd72b14e2a8e60b\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"63d049dfa18f8e5c\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"b4c22d0cd9138892\",\"/knowledge-medium/src/data/block.js\":\"32a81ca384f9016d\",\"/knowledge-medium/src/data/blockCache.js\":\"fca149695e412fb0\",\"/knowledge-medium/src/data/blockId.js\":\"1e4c2e5b8fa08a2a\",\"/knowledge-medium/src/data/blockLiveness.js\":\"36f79daca9271a7d\",\"/knowledge-medium/src/data/blockMerge.js\":\"abbaacf5c7adaf03\",\"/knowledge-medium/src/data/blockSchema.js\":\"59c3596579fcc55a\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"d3272e59023e7026\",\"/knowledge-medium/src/data/blockTypes.js\":\"e5672f13b04bad59\",\"/knowledge-medium/src/data/clientContext.js\":\"f4e996021e1f829d\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"3b0ff44a94dcb514\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"871da50534819378\",\"/knowledge-medium/src/data/derivedIds.js\":\"b0c49665454bcea3\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"bd6de373eb896578\",\"/knowledge-medium/src/data/facetBridge.js\":\"8cc6e5dcf31c2554\",\"/knowledge-medium/src/data/facets.js\":\"71ef422594f7b324\",\"/knowledge-medium/src/data/globalState.js\":\"d3945457ff6741ff\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"7ed6ddb0413b5e53\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"81a07828e6ecb791\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"626219b4e0bdd7c2\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"68cd9939db9fe6cc\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"defd1e25cbdbce2e\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"3a19e1d314c69716\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"59514f6c4fc106bb\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"89333d8ad876a481\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"b99407461746aa18\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"ad01ebeee795cf7a\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"8637d018833b35f2\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"8fbfffc5fa054274\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"61bd37202f66f902\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"fb4374a4d5896e9e\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"da7cf496c51b4768\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"2b3338deefe367ed\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"26d98415230eee55\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"96c54724b3d7d75b\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"675c95625ff64a79\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"4c03b971ca3794ab\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"ffd84224a6195684\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"b04ce204992a5f48\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"5633daff979185e5\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"fa77d37636d64cf7\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"3eaddfea8059463b\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"96b135dc592c2f09\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"d7cefe57b9c1b6ff\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"175b4304a414c35f\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"cbcf91d7eabcd71f\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"0cf4e87d1da5dd21\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"15ce8cf6d22d7ace\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"5cd5fe035cfeef1e\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"6fa99ccb2d8b2653\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"f5f20538145ca8b2\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"15f7e3e4c05e218b\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"0f3733025ad9af51\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"aa390f8998e914db\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"8c9a5b877df1494b\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"92e0a2031825f804\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"2249acdfab388b67\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"edd1747021f175c2\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"781d4ac4678e9199\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"d1599b963b5f4543\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"14194a082b7e5cd7\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"394c0cd7140b1ae9\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"159a88c4434c18e7\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"8f2d756887fee1df\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"ff7d5660ccb7edbd\",\"/knowledge-medium/src/data/invalidation.js\":\"8d1b8a7a8395615b\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"1f0d33f2b77a0838\",\"/knowledge-medium/src/data/kernelPage.js\":\"429574b2c755ecc5\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"01c4a56d46a3ec38\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"8f814f288d928158\",\"/knowledge-medium/src/data/localDbStorage.js\":\"5235dcd2a2229808\",\"/knowledge-medium/src/data/localDbVfs.js\":\"f14a32adf3a2931f\",\"/knowledge-medium/src/data/localSchema.js\":\"184a57e60a8c02be\",\"/knowledge-medium/src/data/maintenance.js\":\"e025bef966debb56\",\"/knowledge-medium/src/data/mergeProperties.js\":\"3dee39859ad47d12\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"448048f821015b63\",\"/knowledge-medium/src/data/migrationsPage.js\":\"ab857313e181b11d\",\"/knowledge-medium/src/data/mutators.js\":\"ab0abed3741bc61c\",\"/knowledge-medium/src/data/orderKey.js\":\"538f65aef6bacc28\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"58b9ebda7b4ecbc0\",\"/knowledge-medium/src/data/outlineSurface.js\":\"ad625132d6cbb40d\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"0b655ac5a3b2a216\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"7358b1b776f88441\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"9379bf2e356c59eb\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"c905cde8b4edc2e8\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"a15bc9b8a497baa1\",\"/knowledge-medium/src/data/properties.js\":\"661292bd10f2bc9f\",\"/knowledge-medium/src/data/propertiesPage.js\":\"91db89b49ddf0a6a\",\"/knowledge-medium/src/data/propertyChildren.js\":\"65da8fd5861cfb6b\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"277d61940ef9c011\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"ef372b7f4e00b218\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"69540073630332b2\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"a9f53e62c8e277af\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"53afb35d7fedcd74\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"742afa3693621618\",\"/knowledge-medium/src/data/propertySeeds.js\":\"e7ddb9477178443b\",\"/knowledge-medium/src/data/recentsPage.js\":\"e9e6c07dc00495d2\",\"/knowledge-medium/src/data/referenceBlock.js\":\"8c68bd259f99cce4\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"bb8e2e41c0557238\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"a1b71a04418d3af0\",\"/knowledge-medium/src/data/repo.js\":\"4e705aecdc91bbed\",\"/knowledge-medium/src/data/repoProvider.js\":\"c546fa59b1ce6207\",\"/knowledge-medium/src/data/rowProperty.js\":\"a74607e3b302f172\",\"/knowledge-medium/src/data/searchFilter.js\":\"e65d99b8aa26af4f\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"c56d4508c5042009\",\"/knowledge-medium/src/data/stateBlocks.js\":\"c64a71eb7da47e5a\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"07724f26fb167924\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"dfa00b8b3efbcac5\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"2d1bd4f07eb1b318\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"fecaa72cae33b9e9\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"874f014213a0a1a8\",\"/knowledge-medium/src/data/targets.js\":\"b67ed520de7b7374\",\"/knowledge-medium/src/data/typeColors.js\":\"7301edc91e375bdb\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"1cbfde983ba04a45\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"955b1311e307f470\",\"/knowledge-medium/src/data/typeExtraction.js\":\"16691d854efd8b20\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"274b705f0c1268ca\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"f3829bc0f566e139\",\"/knowledge-medium/src/data/typeSeeds.js\":\"f270dfb9313b8e3c\",\"/knowledge-medium/src/data/typeTagger.js\":\"5a829c01a06c153e\",\"/knowledge-medium/src/data/typedRecords.js\":\"c09f23fa699a5294\",\"/knowledge-medium/src/data/typesPage.js\":\"e964cc1d2d01f9c3\",\"/knowledge-medium/src/data/userPrefs.js\":\"fd29c332e03a32e6\",\"/knowledge-medium/src/data/userSchemasService.js\":\"b7ee31df735f4bb8\",\"/knowledge-medium/src/data/userTypesService.js\":\"765ab7612df9cebb\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"78a59e35723ef8d9\",\"/knowledge-medium/src/data/visibleChildren.js\":\"442113e4e0439359\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"57a44790dfc6f6ff\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"411e1c40187efd25\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"ca87aa4b9a95ca25\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"553c892aa5df8a2a\",\"/knowledge-medium/src/data/workspaces.js\":\"b0ea524f974a6433\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"42abdea1b8caff63\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"4105b0412513670e\",\"/knowledge-medium/src/editor/atTrigger.js\":\"2ebc8e8fb805ab52\",\"/knowledge-medium/src/editor/autocomplete.js\":\"22798c0e9c84d5e3\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"7796bf9d61c2e05b\",\"/knowledge-medium/src/editor/contentFlush.js\":\"eb2a3ac8548eafe7\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"bd25b515db8f4268\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"6fbd3e1a89daab09\",\"/knowledge-medium/src/editor/insertImage.js\":\"8c9a8355f29e89e8\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"0e1308d5275c0e7d\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"4337c8ad078a20b6\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"6b091278181abb11\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"621b89e5b914a582\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"fc1f9c1f9c9471c8\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"fbaea23f8c67cf20\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"96719baaab2f883e\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"31bd450055c6f369\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"f27dddbec72db620\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"ae0430a2e796bb98\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"64519f41a54fb5e3\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"4acc38daafa44a96\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"33acca09d2b03e18\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"f7acc89880f0c904\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"dd1a663605bcc48c\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"7a8296bfd1150728\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"49846651ab253a67\",\"/knowledge-medium/src/extensions/core.js\":\"95b4369f6ed12904\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"7b4aa5e6a34f95d3\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"8fff21bb848b52dd\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"a592e0e26f18834c\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"f5bbd97fe936d4e8\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"ecb94b8cd2f0d463\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"fb9bd38b72092944\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"f789047f35604a1d\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"0f72060aa46caa2f\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"35d2eeb06980e763\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"1304c8aae25ccb43\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"a4379425c810f31d\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"9f819b4e716d08b5\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"6fd42de4e160a170\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"1720f36d5ac08eb0\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"9d0e4f46ff7d724f\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"3c6dc3949377f608\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"cc9b41635fb27a70\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"1a0d54e2df85a53a\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"dedce76df9095c49\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"2eb256507c8a1e2a\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"ed501e93035647ea\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"7a228947199cb990\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"7f00fd6cb2095227\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"98005a93fde19d4c\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"5ae1c0beb3ac1ad5\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"42fc5c93ffa7d8a3\",\"/knowledge-medium/src/facets/facet.js\":\"23d906f65d25d134\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"75b8b053ec48d721\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"435389223f11c18c\",\"/knowledge-medium/src/facets/togglable.js\":\"55fb3469add52ae5\",\"/knowledge-medium/src/facets/variantFacet.js\":\"02b82f5483319c8d\",\"/knowledge-medium/src/facets/verbFacet.js\":\"6c90b5ae338234a3\",\"/knowledge-medium/src/hooks/block.js\":\"0e4ece07ccbae61c\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"ee8bdf311bce20bc\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"07d83501708e3b11\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"f7312fe8c664a419\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"e748a3846c1f3ad1\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"42cf1a70d1538a57\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"ad362e510c7862cc\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"07ee464f365d0f2e\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"932d1488f76e2de8\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"497180afae560294\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"5899a7e6c99db032\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"1701b3266204e860\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"da4618baa78e46cd\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"67d2180eb32e592c\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"9fd6b17e0bd1a92f\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"1a01519040fc226f\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"c5818ef1aaf39ddd\",\"/knowledge-medium/src/lib/utils.js\":\"15dd0c56d63dfd95\",\"/knowledge-medium/src/main.js\":\"7782e10a88d3ec2b\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"aac438621a84c601\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"599942ff5bcaa6fc\",\"/knowledge-medium/src/markdown/context.js\":\"12783d71a30ab58b\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"5c964d1cd713f53d\",\"/knowledge-medium/src/markdown/extensions.js\":\"46b8a7659e17cd36\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"a443fdd920d9f0d7\",\"/knowledge-medium/src/minimal-editor.js\":\"625b3442c06337e4\",\"/knowledge-medium/src/paste/armedCut.js\":\"6a63b7d6893b37b4\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"ab3f9d9555f57995\",\"/knowledge-medium/src/paste/clipboard.js\":\"f8c74f64aaca0405\",\"/knowledge-medium/src/paste/decision.js\":\"55dc16ef2464b74a\",\"/knowledge-medium/src/paste/operations.js\":\"83b9548d776cd440\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"155bb9a4f588573b\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"11eab79c8cdc1fdb\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"e36afc3ca1b03df9\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"2f49f96476fd8943\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"2f19a562dbf341d6\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"7e323b6f899a038a\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"50f59a95e3c8f05d\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"dcb75ae15fdede7f\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"18cd2b3a0c6d6f7a\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"ddb9908a1d12424d\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"a27a3e440210dbd6\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"cb747efee34cc368\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"4a8beb5c3a2bbc38\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"5bade3aff811d94f\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"00dbc17b6c61a991\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"5fb727ec07df3aed\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"bfd42aad6cd1ed94\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"4966b92949351f32\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"d0dd5e5c226e5be6\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"970a57012c77cc53\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"4a1f1fe1da4dfb7e\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"c2b449bf56c720dc\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"5402cba28e2c3c46\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"3cd3da218d14771d\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"9134751479825eb9\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"2d9a41524c34b363\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"2b982ed00b9a588f\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"1e479da11260494f\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"e1ae0cf9e739e2b1\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"210faa2c3cf4ea6d\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"b775406c09258a49\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"bceceb2a0dfc9167\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"1a0da47f90b8948f\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"5b30b346669e28a1\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"800221b3df5cf451\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"23c3dee80b07219a\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"726e8a7c57c611b6\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"5c71066c1328f482\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"f4a1e48f50b657b9\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"4358854fc863bcd0\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"be97e4d65df55334\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"528bd163fe1a588c\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"5b754104025571ca\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"d15468c726c378d7\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"6b7178279ec073a5\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"331e6ac120da5ccb\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"9f5f352ce2d3d6b8\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"ef3bb5f694456702\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"69e486b7aac73abc\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"536a6b60501efc8f\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"44fd0029d33ed0f2\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"cc838f0c6851f468\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"b0acb4888463e1b9\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"c9b9dcf4c82b5863\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"d941cd797fb6242b\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"27ff07f5801e563d\",\"/knowledge-medium/src/plugins/alias/index.js\":\"1725bb4d7e92bc3e\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"0ba31dcea3da4d00\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"09f98dc4445c9e44\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"d310c41c85e32101\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"5d27272c106011ec\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"f24a65ba7a4e07f4\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"ff7d13972a75bebc\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"6aa0424a3386d4ce\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"59e31870a870ae5d\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"2f0ca31666e01a9a\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"be720c64b6fd76c9\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"27d78faa87fdbdd4\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"c3be688dcc35bf15\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"17ab10b3fb0ac37d\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"85618aaac7918d7e\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"e226b7dab7de4406\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"82e24c4acc4d5c83\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"2892200570b9e50c\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"b3177c0f10ec7b1d\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"d4a7904de4fb140a\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"39c22c7374356d50\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"77af38b47528aba0\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"1e877dd1fe1e97c7\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"8e45522925a7b965\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"75398768ce50f6d2\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"cf4a74048e588cde\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"01b6d563cff0b2da\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"503e04a9643c4465\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"5259a1ba5898ee67\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"6995bd7dd43e082c\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"41790b3c78f5b0f8\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"00cf9dcc5307f8ee\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"9a1feac78fbd3c71\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"484408713debb9be\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"7e60a35c60f3fbdb\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"4dcb56c96bff1181\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"f707752bfebc5e14\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"3bede66ffdc723c1\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"6c3b849437b53989\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"9f29bf9d79202426\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"d145fd421a47d42f\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"bdcfd74b29c2a156\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"7a9c6c3aa1142d4a\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"b1e06a53f73f413e\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"6f858a14f4ef3a49\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"90b6e6b314446e2e\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"c79f1e7e87852051\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"052bfa64c21bf3ba\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"6477492de6882113\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"5e12a72cca2fd3af\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"3d2e22393e23479a\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"67f4b5dec5573253\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"095b6b68e9999efc\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"405535a9a46aabb4\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"e556ba0dbc34a536\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"5426986134c05267\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"bcddbff75f97ef7f\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"48e6229e9e6bae90\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"579e1386101572d8\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"ae9d48fdb2d20c4e\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"d62698ee7b6f096c\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"c7263d2ebe0bac2a\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"1b7f2a03dcd08e2b\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"95dc772ca6657319\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"6e68d58169618c1f\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"86e3c4e84e014686\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"0072b96453bb24bc\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"871f49ea59c6db54\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"dd63f15691bff7dd\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"e901aea82d92f815\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"18c9b1f344eae108\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"34a1f92bcaa0bc71\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"f25911521fa1f8be\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"15ea9ef1371d6ce5\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"bffe40bd707fb514\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"4d5c471ca5bbc104\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"37e993eba78af840\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"4d0a99ebf8574c3a\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"47da8d429049e05a\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"ee1d153c15040582\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"f618f8b120b66d22\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"552e6a3c716f94d2\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"d32ff91e1da36f25\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"22d1b5e6ed90245c\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"7a5deaaca5504ea8\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"66ad858be4fce3df\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"6e44b9a62476de1a\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"df79ff7d256cb05c\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"0e5582b6be633d14\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"75ffb52ad8267267\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"e1c5807d81829c6a\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"4d357880ab7c962e\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"b32dd17794b13ff0\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"2fc9680afa54a091\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"a9a1e3786233adf5\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"6dcddbbb2b55a890\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"88a79553db009e97\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"14df0a55ba9ab3a1\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"9564024e8ccbade4\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"ec284b683d2f14a1\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"06155d63ae22687f\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"10c3719567ffd60f\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"ad7c60e302f50137\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"572214523682d923\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"ae35b8d44c6bdbbe\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"6e1b5dd9046eefa0\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"e6a9d04b55513cfb\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"3da42b9adad8af65\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"077cf4999b683a0b\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"bbf8301aa9419108\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"84e43a92e0e01e3f\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"c1ddfee0a16a031b\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"1bccf005dc85e14d\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"a973a0c69b4d71d0\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"1185509a902629cc\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"744db05c631a86d7\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"7b6c3893188e4210\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"30dcbc858635d9d0\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"7433789a35877e72\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"2e68d3689f65242a\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"c9d19a70578652d6\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"fc4a55cef17b4010\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"0c6260052b06043a\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"115ad3ce0e075994\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"105afbf7a8f2ef09\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"266d9cedbd925f30\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"48ad678492879316\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"0b9a41ee8dfbf8e4\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"147951d1ff38326a\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"b4e21d4e2943d57d\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"a9c4ca46d58b1a82\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"53b2aee5deb5981b\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"73aea76462c255a4\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"e0c8159bf68a3f0f\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"2de365272f30e5b8\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"46516e7fc707b9c1\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"4c6ae0f6bc2fec7e\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"470c9918c19e20b2\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"0f371fcae0f78454\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"489437711ee1c310\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"116bef728763cf12\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"fb7db942d1ca2ed7\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"6e9b7be34095072f\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"81acd694012c1fd7\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"eee00cd8ef177561\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"a2ec4704f6d091c3\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"7ca8904ac4a9f040\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"a58d9466f5c05ce1\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"0413a2849257d2bb\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"d95fdf40a0ab9505\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"d049d0dd062a2f6d\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"ff007e15db49c25a\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"d2cc47eb82708bca\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"256b883cab98eaa9\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"ea4bb17aa881ed77\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"7c2b1e5c8ec36be8\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"80edd5cea54bb58e\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"d4f52c6149efe39f\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"32ab026992043dac\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"e5e9bf4f59da6b25\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"af750f16d6278101\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"bc99afa6f0a4b0cf\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"58dc946e6eaae54d\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"0f33dcd385f33a4b\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"986cd0fb2a013526\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"8950516e9589f88f\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"663ef85bb50b4b5b\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"06f5abb70940d386\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"036ce1ca61f42c88\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"8e85fc1e7596b76a\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"0d018df02fa86899\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"e59bc2ca49d5e059\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"e4bbc47e8a416bd3\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"9ee1a8b65866f177\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"07eb30a3c329bb6e\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"8d57adb4da545caa\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"091a5393a5d5ee2a\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"678d4ba32fd2ca0c\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"f8005de6cf77474f\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"0d3028664d4ca9f4\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"9c65b6254c5673f1\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"3eda807598491417\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"92a8807dfdb43ad4\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"d842291650a13bb1\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"f177e7b81f2de704\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"c9aa8c82809b683a\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"3cb405354da4678c\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"8490328900eaeb8a\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"2ea98d6071443e18\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"2f031e435ebe8e0e\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"80d46d1f44f44cb2\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"8eeeb0e1e4ba568a\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"5117f843c1a26e12\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"9c7cd23bd16e4bb4\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"bde237ec018f4336\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"34aa952d3d8db1ce\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"590e8a2942f5f425\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"5e29b3b2d7701ac1\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"5a20951ef89cc0fb\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"f8d9a8c8ebb39a45\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"6479e8e5930508ea\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"a93da9b8caf07b0a\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"b5ca361aa266055c\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"58bafc8fd8e2081f\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"b5f39c5a15a634e1\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"a40a6cd5b19cf857\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"8ea728a8b576a3f2\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"87394220b0489626\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"8a7e91e2ae29f6d9\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"93bc3258872a85d3\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"e8e2202310874eb8\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"f0346dedd9e4a80b\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"37eed872e7ee2947\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"10a3d020ed3a5405\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"2209075419349abc\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"271571858f2f5e6f\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"b173156345249277\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"b799a27d00462f90\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"5ce969f367904839\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"3e006dc4f9ce2a40\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"ec141c8eb15ffc60\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"a6b30d6481275e6b\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"27a7f9a3860816df\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"3df915c0a3775fd1\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"81ed3dfc40d873e7\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"01a514bcb3e4f121\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"0c3da2480ae8e67c\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"1c4c2ef5dade9662\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"8523f1e1b313d2c6\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"911f240b0d4bda1c\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"9ba0d5a94d1dd0ee\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"52fba709d3ab5d78\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"6675d141ec48e707\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"e4282ec0a4852d8a\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"ee8fe7845bca14a5\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"e67298b74c6f267c\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"16ec2d90327f2b10\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"b88b1a2947b3d5eb\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"bebc2d3e6cafd050\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"2c553b6b61ba1196\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"28bea0d0f6337513\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"65755ba7b748a5ec\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"14d4c7273da1d986\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"374e168645841372\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"718e80ef5ee97e7f\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"febdf710b2ec05f0\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"399e725b77d97db3\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"bbecd71fd5fcfe52\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"8f995ce8be54a226\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"ea17d798379debe3\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"82725fde925672f1\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"8ff4c5e2dc449318\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"d6b0f6abcdccaf7b\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"cd38553ff2724db2\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"3bc95806759cb0c5\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"67c77d1502f24086\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"33b1214dc586c130\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"e7cd605713d0af63\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"dcea30e8c0f911f1\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"ba599d1d65371fe3\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"d26cf21e82de0d82\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"d0339d9a551187ca\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"31e59deeb2461ee3\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"83c4b287e43a9950\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"ad0691dd67447c0a\",\"/knowledge-medium/src/plugins/geo/index.js\":\"3a4ee42ace3d2bbe\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"eee119e7f3292fb4\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"6f3fcecde69f49cd\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"2f3eba254766d4ae\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"3750e5fad4064ba4\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"9f765035217bbd1a\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"145771c7e8bc9a8a\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"87656ebd826470fa\",\"/knowledge-medium/src/plugins/geo/query.js\":\"5fff09c7fd61b942\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"92186820cff6c907\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"535ed248eb5e8101\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"86e86b8340a4dbaa\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"241df0466952af85\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"f04147f0642a7b1a\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"974f862e6dffc51f\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"cb3a947e7b59221e\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"f1c1346edce7dbc9\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"c866d219c6c4f99e\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"5870585b93a5e7c0\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"1457bb549e9286ab\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"94e4786f52071a70\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"a1f5c8eb04cd4353\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"72ff9043c6344ab2\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"7e75a1ed698de369\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"3a060f2068fe0d36\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"98a1b7feecfe9077\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"b10ebb35840b394f\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"30d73645d08c1e10\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"bbd01348ee76ad87\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"65cfb6618265e5c0\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"db54ae9fd28a27ed\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"3850307703267cb0\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"140417c38e7bdcdb\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"cdd431044fb895a0\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"4ff755ccd7779a47\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"9b49fc3fa79cfd93\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"690048686f41f423\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"71f70380a60fe971\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"e430cf313d599aa2\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"7b035a5a4d77eefc\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"5b58e9ed3055ddee\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"c850e4b8479437d4\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"203be77d92b933fe\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"c4f7c959c3e98dee\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"01bea975e1251529\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"e9e3e80e0a26a08d\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"f6300f9a597ea53d\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"1b4ac35945ede4b5\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"913384c1f749c3ba\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"f95f56db269a4ceb\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"513c7ddbedf6911f\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"f5771ce1bb86754b\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"12607ce33e72fdc5\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"18fcdf0b3518a975\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"e7eb8d71e8e992d4\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"694ba949b9f56528\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"649718661acaee5a\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"0801b66cd98ffb1a\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"623f9c7645e96294\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"aefc9570e43373ec\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"53076c512239f177\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"70c3945804097721\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"ed4e5f1eb537569f\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"d897b0673d6f9e68\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"55fe3985bb77c2e2\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"cffe2a73f26aa63e\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"e3fe6e75de92d593\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"5ed6e95c40c8486a\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"db6f8fa64a684bc9\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"9afb8c68e49577b0\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"f28069ea0e6198e7\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"35103f95bb1d25f5\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"8765437664ff2a00\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"a10155d4c6117bc7\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"3d140269baab1f97\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"ee9ef1600b52d948\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"edb9eecf6866d5e9\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"06c7c9f1ed0239c1\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"d2967eb24d9793f3\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"4b1c99fb0c2bdc0e\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"bcd5ffae01a3252b\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"aa1fffc41f55ef42\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"27a06be5613c8aa8\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"329734f4d6587f45\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"7b6155e8cb619f74\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"9c1f00e7f0d0a8cd\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"422ca6a2f78c3bee\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"c3a767e3a72c2e28\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"2a00fb67629b24b1\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"5c677f61b0243c73\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"c0ae90d993039be0\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"0d9eeef4f91584a1\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"dd971ecf0b561c97\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"ccf3fe85a25954be\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"108fb1b216cf5afb\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"880f0ab04bcfd624\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"a7e14dff50aac850\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"7812ddd568fb9c1c\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"a7ce21118e3c4000\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"4e828466458b8973\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"a08e02104d49656f\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"e43d6bc7dd6134f5\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"d505938675b84d6c\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"09284a9212894419\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"0c2c5af0bd179a7d\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"aeff8ed708b6d69b\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"157ccca12c33155e\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"ef023f139164e5c5\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"9862819c4ee77c12\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"1fbaada470b6dd71\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"9e3658634d356af1\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"b8e6d54fa6a7da56\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"ace00dadab085573\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"f4ddec677767900f\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"9841e7653554c81c\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"79814bb284d93211\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"92c895e652d37fda\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"502dd11a840a505e\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"94de1254a1affad9\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"4ce73e9fee3a0376\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"16cd28bece2cce15\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"d085fc2686f75cbf\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"bac3505269a75aba\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"49b5eda0baad6d1a\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"e9605a3729ab81cb\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"ae6ae9a58c185abe\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"7126a507bf36e453\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"c17f853c606ca95c\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"5b2759235be90d07\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"922f76ba5e5d78c1\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"239465e7d28349be\",\"/knowledge-medium/src/plugins/recents/index.js\":\"9decdb0fe486ff79\",\"/knowledge-medium/src/plugins/recents/target.js\":\"e5dc170ce6b2281e\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"558366b3f24d1c6e\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"efb5d3f1b90d92d3\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"85027a521148404b\",\"/knowledge-medium/src/plugins/references/index.js\":\"8390351dd77cc210\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"8d2a136bcfe4048a\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"6b91cc1db4e473dc\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"d50216407cd18b5b\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"d86dc6f54fd5b6e5\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"44960ae8b7cbe61f\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"9b0dc9678d460f88\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"35963e5dfd3bc573\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"7e69733e9c4564dc\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"119fcdb7fdb393da\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"e7f4b0db09f49232\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"20156a03c70c186b\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"f7c88a66f38eda71\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"4fb3dd2951786444\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"3cfd6dbdbb46bccf\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"03218f13977a61b7\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"3e1f763ebf8a2a71\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"1c88f9bc3ca07a81\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"ef74bef3f037e441\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"113f4c771ccc438b\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"dbf3f95b2035d80c\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"be2f8c6cd0b8ddc4\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"35d202206889d9b4\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"39041a153bfd58c8\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"69ee7112342c39cf\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"aa5516553e8f1884\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"96aad3e889e4ed86\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"4bf66fb4f9996e8b\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"df56dabf34232a49\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"6e5e8d5c0a68e46a\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"ad216ef5ba7f92fd\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"029c5f051ae98d17\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"4d494738fa4c8933\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"96fb7e8e928e60a4\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"cacadfc2616a2e48\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"990ae5521ce57367\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"2122f81168595134\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"f6e801f2b9c86e03\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"f3328ddc24450bd7\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"c64e7a6ae320d4c0\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"131eb5ea46823ea7\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"7ade52169a847155\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"ec36c8df13c9c665\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"6de7d9270609cef1\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"d03f6c8d2acb4ed4\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"c552436987b24332\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"e041b61254f310ef\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"6c396c6643787c4f\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"e0ba2f16da30928f\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"c9aaa3102ef7f4d2\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"9be1b2ac2d976a1e\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"c98a4835b0f2d566\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"e0b4b5480f6d1f49\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"0eedc6eb070198d7\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"972af9625d8a7679\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"d2b136cfbec95efa\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"e7a8f84bff969e63\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"9f7a4e93861c8324\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"227197e5bb5e4c08\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"1ea79faa85e20368\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"22b5b5038efeb725\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"a71ca53820bea22b\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"0566273ffb6122b0\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"a04b596b5d5f52f9\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"95fc1f9f476fa024\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"30d63a51a855ec1b\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"8e29d91b83ee02f1\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"ad42b18c6f41d58c\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"a5377537e9208a6c\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"053714d5d5d6ff0c\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"23f3433ad9536fd6\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"47c5a6415d66b8b7\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"4a500ac352356a79\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"1b6114b1f1456a28\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"abc917acf74951a1\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"39d398dbef7ba08f\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"2c57bbc2f8a6e942\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"2ccd05b5e4251125\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"26a28383faa1fd5b\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"3892be0fc0021445\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"f69c44000535e2b8\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"3f1bbf8311d101bb\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"e10d1d239d3168cd\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"f6719c847d4a3d22\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"e02ef54a4183f06e\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"48936a179745a2f4\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"12b946335872797a\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"21f81e6e75eecbcd\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"6a042a2b8ef3e740\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"5612a0e63cf619fb\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"8fb84be2339c3599\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"92e950c01aa45aec\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"118ca4ace36249dc\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"827ca4ba2eb2d95b\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"15b215a64f25bf85\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"e8e07b98f75b59ea\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"59955ae11e83d0d3\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"a01a3946231bbda9\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"3b544649e34fda80\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"d1fb95b83e5aeb19\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"ccceb0f1ed63a7e9\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"7795e07ddf5b314d\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"379472294daaf96b\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"08ab16e4ea7e9bef\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"12de2c8266e46a25\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"3fa57dffa2e61fdf\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"ac35b2b8e25432fc\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"e74e59c57d1a4309\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"5f091b3deb365369\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"21f4e00b7a1d57fe\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"949bb6b08da30196\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"db9f5f134db4097b\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"c0e85150b108da2d\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"9a4b6140db4ed919\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"89ed0f4d5b854cab\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"1fdaea92bbcec5c0\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"3f153e616fad5756\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"2f90814263a63aa7\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"cd8e72636830c1d7\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"f1c17981d11b2381\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"3cdc805a4de3c33b\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"f9ef8e1316ae7c5e\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"5b1f179eb60768c5\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"7c99ca6eddb493c8\",\"/knowledge-medium/src/plugins/tables/index.js\":\"781fde89fc083c13\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"b403d3312619b1ed\",\"/knowledge-medium/src/plugins/tables/model.js\":\"eb12b8e22f2f5d86\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"45a68aff6bd36e19\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"3dabfbcacc34efc8\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"01b8dc0b67fb7fb9\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"d3f6ae49d1141975\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"e889575ab4be21de\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"431437c9c3937ed1\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"c29ab82dd050e141\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"c7c19be36c53f582\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"1b90bed71ef671cb\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"ba37bc99e980a2aa\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"13df5eeecc6b1d2d\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"a2eacdfbbd893fc5\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"8fab61841715316f\",\"/knowledge-medium/src/plugins/todo/index.js\":\"7e8f10330dd6718b\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"29f36b9ea50a086c\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"98268a635ba98a83\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"941b2f32dc00475e\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"ab39c26c9c388d06\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"71cc98fa3483d006\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"ec51e89e41ffe6b6\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"f9d2d2cb32b337da\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"6b168dd3dd83bb91\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"0b93cc471fb6bd58\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"fabba833f18d01f1\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"12aee3bbfa644716\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"11c88831d1bd634e\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"87f457463b45808c\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"2f203a5c99f2aef1\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"6db9271e717c15f0\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"f6fb319d14e68479\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"07742a3ce014f036\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"3e86770f9f304589\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"a980b33bebf980b0\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"23b67d0d316909d6\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"e5f2d3994f93c127\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"1473b6d152d30886\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"1c0972bf9645f763\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"b85b62b0f351e487\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"b6f3966ec2d08ce0\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"d20aacae855805cc\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"b000255312c2ed96\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"95e5aaad436b7fdc\",\"/knowledge-medium/src/registerServiceWorker.js\":\"3322a05c186e9da9\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"9700416ea7ed131a\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"ced03a8df71d56e7\",\"/knowledge-medium/src/services/authStorage.js\":\"9d7b5cdb9dc0d190\",\"/knowledge-medium/src/services/powersync.js\":\"e752e577503cc1dc\",\"/knowledge-medium/src/services/supabase.js\":\"d7d3ebe62e00e988\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"23f78503abce18ea\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"73e5ba691a496f7e\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"88ceea88a588c22e\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"3195b0c9484e34f1\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"a9b17b01505410fe\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"5b08dc1814ea944a\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"68043816192acc56\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"50c497cd1c328cc5\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"23b0540459428925\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"5c67d508309641a9\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"28fbff4aa69cad2e\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"b45594d4666b5f5c\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"91e21fafc4d18f55\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"86c12a7a54c67c68\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"4f4d2a72496eb5ae\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"83d4e000592991c9\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"42eeb102e930a3c1\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"0389ec72fee13961\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"c15ebca2588eaf59\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"21d2988af3aa0d39\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"f894cda13a714bb3\",\"/knowledge-medium/src/shortcuts/types.js\":\"d0e3ac2f15b1ee90\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"32f4844f08497326\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"132e26ccf333cccb\",\"/knowledge-medium/src/shortcuts/utils.js\":\"49bcaa3ba1491df0\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"09dd5de607fa4ac5\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"f5de8ec72b526651\",\"/knowledge-medium/src/sync/byteTransform.js\":\"9c265056d1f5a8c9\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"96536184bb1e4765\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"ac70cae77de8bde1\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"c485bb30ad81312d\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"09f1452c301eab50\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"316bee5a3cf35d87\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"0bab867a4fb77e05\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"3260fcfbdcd45983\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"50bfa4b3cfc379f3\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"1131bf478e4fdd79\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"aade7d78c59df429\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"7522b2af354a086c\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"6e84906501539d09\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"834a3be2dc2c74c9\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"2e39111cc1ba9f61\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"cbc6c21f82217996\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"9fd74c351f06ed13\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"4b3375d580475369\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"d7f8304ffe8ceaff\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"da103efa1056a7eb\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"5d16132e733667b5\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"a6e6d2d99fc9acc5\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"dbf70fd9ec478302\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"82d33b75b3a1ba12\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"a16b6ee481b9b3f8\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"ca95abb57eef0e17\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"167f9ce35b53fac6\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"bd3fe63b782ce412\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"7f2970309d2a11c9\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"8b9681b1dc1c6c22\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"83b5a08651948da3\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"02943d2c5649424e\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"4682db7842a43c91\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"10a708faeaf5ed08\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"13901e55af8a619d\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"ecf1b26213593695\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"b40aebf1b85ff11a\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"b6e33dc25d9ea3a3\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"5abe0a3ee91f2357\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"42d4c3a9ac76f6fa\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"831f6d8196917cf9\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"850650be543fe8b2\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"53fd1bf00197616c\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"bca52b8450030448\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"afe55f6d2f8d2ec1\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"ae981c714c964aed\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"9044653db0fea8d4\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"3eed54d5269124c4\",\"/knowledge-medium/src/sync/transform.js\":\"60db0fe7a1a96204\",\"/knowledge-medium/src/themeBootDefaults.js\":\"86ca00305d9efafc\",\"/knowledge-medium/src/types.js\":\"a32fa89da932a6ce\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"dcba041e2e91bd24\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"1501f4b5ccacde08\",\"/knowledge-medium/src/utils/array.js\":\"e45037588ceae4d1\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"ef16a774d04e553e\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"adbf2af0cb0fae99\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"7ba817d4e9ae6596\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"f14463e5cf65b855\",\"/knowledge-medium/src/utils/callbackSet.js\":\"94f95f7076bb2d15\",\"/knowledge-medium/src/utils/clientId.js\":\"a6a8743334e8088b\",\"/knowledge-medium/src/utils/codemirror.js\":\"f5af557b95b97cc1\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"61df78e8045d3104\",\"/knowledge-medium/src/utils/copy.js\":\"bed0b83cd031434c\",\"/knowledge-medium/src/utils/dailyPage.js\":\"fc2dea4118e4b7fd\",\"/knowledge-medium/src/utils/dbForensics.js\":\"4b495c58be092a8e\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"ca489b76a1c714b2\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"51c30af30fb9f982\",\"/knowledge-medium/src/utils/dialogs.js\":\"26031ab48e477b54\",\"/knowledge-medium/src/utils/dom.js\":\"cb33f1af4ab0f472\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"c68b315b7f9a1754\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"083f3b2a6ed03c04\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"c391736cc79ef55f\",\"/knowledge-medium/src/utils/flipSlide.js\":\"3550461dafec885b\",\"/knowledge-medium/src/utils/fnv1a.js\":\"8787c17e3b33d6de\",\"/knowledge-medium/src/utils/formatBytes.js\":\"1a2d24452a5e5cf3\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"7f1c69689dbcb327\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"db63d452b49fd5ee\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"28f5684336233278\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"02c70d21060ba704\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"ad13aebca3fb86b0\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"26a4e3ff62b22540\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"c3f00ad8fc36eaa2\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"e1957039d7436285\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"2a9873d7ad447959\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"8a542197932e8647\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"6095badd6cad13cc\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"51386b22bb40d36e\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"e9848eeb316d1cfc\",\"/knowledge-medium/src/utils/markdownParser.js\":\"e854216164dc765b\",\"/knowledge-medium/src/utils/memoize.js\":\"2ca0a9090e1c3b99\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"ced22d2a8e882a6d\",\"/knowledge-medium/src/utils/nameList.js\":\"498d7c43c0807bd4\",\"/knowledge-medium/src/utils/navigation.js\":\"859f59363fb3c3e7\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"c33bfb94add49a19\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"d6c9d3378512f3db\",\"/knowledge-medium/src/utils/panelClearance.js\":\"b4e296caded5a3db\",\"/knowledge-medium/src/utils/panelHistory.js\":\"caeda0a2d1e7cf2e\",\"/knowledge-medium/src/utils/panelLanes.js\":\"fde5ef2ec38f8b0a\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"8da9830235adb52a\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"9b2271028b4a444f\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"ae8c9557e5514c09\",\"/knowledge-medium/src/utils/platform.js\":\"f1932f856d8e64e0\",\"/knowledge-medium/src/utils/pluralize.js\":\"7950cdd09cc6966f\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"1514fbf1c3ad5335\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"cdba5c79f1c69d75\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"95fc096234248656\",\"/knowledge-medium/src/utils/react.js\":\"85b233db14a7ee44\",\"/knowledge-medium/src/utils/relativeDate.js\":\"5632f87800516345\",\"/knowledge-medium/src/utils/relativeTime.js\":\"34eb7a8fb7d2d8df\",\"/knowledge-medium/src/utils/renderScope.js\":\"0b7605708c13d8ff\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"09ef89d272573b06\",\"/knowledge-medium/src/utils/routing.js\":\"5d662951c71109c4\",\"/knowledge-medium/src/utils/safeMode.js\":\"4c7f4dd58a0a229d\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"1842dd5b9335dffd\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"1d43864b34f38b6d\",\"/knowledge-medium/src/utils/selection.js\":\"9cbfaefbc98a588f\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"23be30cbd4657297\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"489162189290da15\",\"/knowledge-medium/src/utils/state.js\":\"a6ac17792edff0b5\",\"/knowledge-medium/src/utils/string.js\":\"868b99534594346e\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"2709190440cc6225\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"e500f464b2d902f8\",\"/knowledge-medium/src/utils/toast.js\":\"dcc6021bc3a995ed\",\"/knowledge-medium/src/utils/toggleStore.js\":\"8117bf903d70ba3b\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"203512a7590ee48b\",\"/knowledge-medium/src/utils/userActivity.js\":\"652b236780dd4fe4\",\"/knowledge-medium/src/utils/viewTransition.js\":\"afecff8339856573\",\"/knowledge-medium/src/utils/viewport.js\":\"d580669b2f0960f9\",\"/knowledge-medium/src/utils/webLock.js\":\"f77db01cec8293b8\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"f08797d98ae19da9\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"dbf06263afd5feab\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"0be7dbbd2ad82fc5\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"259d70ed2c2e0f90\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"a774a5804d71cb8e\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"c85def5dd85e9f3f\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"00865180c24626b0\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"7460366bd7e2d1e7\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"d1c67bde98bc40b0\",\"/knowledge-medium/src/vendor/react-dom.js\":\"e0ace5d6998a5480\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"4261c5966b73c3a7\",\"/knowledge-medium/src/vendor/react.js\":\"37ed15a94bae0055\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
