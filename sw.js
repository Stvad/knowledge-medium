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
		buildId: "16a29ecb7a22-f68fea21",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"591417a03348e175\",\"/knowledge-medium/index.html\":\"591417a03348e175\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"d6b85c2ba5dde3ba\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-BE60Yu1F.js\":\"c79cd533581adc9f\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"52cb9d0d3d1c636d\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-C0BIybao.js\":\"7b549f08ff7e8130\",\"/knowledge-medium/chunks/FacadeVFS-mj0JyTU1.js\":\"ba4309d6fe10e414\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-D6cerIAA.js\":\"db12d0ff7b6f8921\",\"/knowledge-medium/chunks/MemoryVFS-DJeZkVF1.js\":\"1eada78f7918bb7f\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-CLFv9_kk.js\":\"332ccc038f7e3991\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-BWBr8gAm.js\":\"a779b693945c5ea1\",\"/knowledge-medium/chunks/Preview-D90E2sCg.js\":\"7aa932ae078b350b\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-Ceilp2wd.js\":\"140a59a15acdc8f0\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-CcqpeJ6y.js\":\"ab9069143a0de5be\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-2DGM1xoZ.js\":\"86e6719e69e6b2e3\",\"/knowledge-medium/chunks/react-Bd6ja4GT.js\":\"9cbcf76bd86e6582\",\"/knowledge-medium/chunks/react-Bx9Igyp6.js\":\"acba97f9eeeeca4c\",\"/knowledge-medium/chunks/react-CSCX5kDw.js\":\"fa3ee33761791f03\",\"/knowledge-medium/chunks/react-CxYqwMwR.js\":\"0a1dc35e1d3beabf\",\"/knowledge-medium/chunks/react-CzxwR997.js\":\"831f3df184621f11\",\"/knowledge-medium/chunks/react-DzQEC2sh.js\":\"d09b71a1cd8d173e\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-C3JwPNtt.js\":\"8b761b13417e2e5b\",\"/knowledge-medium/chunks/react-dom-server.browser.production-C0dPX9wp.js\":\"0f8d697b75cd47f7\",\"/knowledge-medium/chunks/react-dom-server.edge.production-DPkVbK5U.js\":\"8ad98cfdec2ef1f4\",\"/knowledge-medium/chunks/react-zYbz53rr.js\":\"8ddf915ff439f77f\",\"/knowledge-medium/chunks/server.browser-LPZjkjXW.js\":\"8496ac235ea45324\",\"/knowledge-medium/chunks/textarea-DXVf-hgR.js\":\"3566eabdb9539a2e\",\"/knowledge-medium/chunks/ui-Bicgp-Yv.js\":\"1c76965ccb0b17e9\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"888df5881ba9f759\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"f5e8a18f945a952c\",\"/knowledge-medium/src/appUpdate.js\":\"4d33ac008357eb4d\",\"/knowledge-medium/src/appVersion.js\":\"3a052945dfc94ccf\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"c62e903dfef11561\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"edb67a45395c7283\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"55e41d8fff511b74\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"e0f7091e8f0625c2\",\"/knowledge-medium/src/components/BlockComponent.js\":\"09597453bad50947\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"be133a924c4648ce\",\"/knowledge-medium/src/components/BlockEditor.js\":\"1f8771645f65f3ea\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"ae0d1257a9a00877\",\"/knowledge-medium/src/components/BlockProperties.js\":\"5dd0db65230f8e06\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"c60876823a7d02c1\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"bfc7562a83a75420\",\"/knowledge-medium/src/components/DividerHandle.js\":\"9b5369bdd1afafba\",\"/knowledge-medium/src/components/DraftEditor.js\":\"ec95571fbad42876\",\"/knowledge-medium/src/components/GutterPill.js\":\"ad7dd67ab3758b06\",\"/knowledge-medium/src/components/Header.js\":\"5e3206d8984516d0\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"0503319eab5736ec\",\"/knowledge-medium/src/components/Login.js\":\"f9f89e87576d85e0\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"cc64174f28a9b8e8\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"b0ac551d1ed78eb1\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"d2b3eac5bbf624d5\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"927e774fda521b5b\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"8c832c795a0b90e5\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"09862f6580473250\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"854013fc0f168c5d\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"f1c7246c740da4ca\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"7fed3c0f633cad38\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"f737c36e7d0680a8\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"ed85981e0977bfdb\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"7ef9e25d57b66828\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"2b35abe961fa32a8\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"e50934af9b03a2de\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"cfdc034a46d46d32\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"1102afb60b978a88\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"e2269541a390d618\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"4144e591927ecaa0\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"1012f72cb93c4b65\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"f9fb34b942449d53\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"d9819f17f7c4ae4c\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"e3ef7c7a729cffcb\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"949264c66bd22c9d\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"29e51d910b0fbdc6\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"5b563419cfcef8f3\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"e90e6afbc728437a\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"3127a8c5f6e56faf\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"fca3c5b76777c97a\",\"/knowledge-medium/src/components/references/CompactReferenceLink.js\":\"cfbeb785329f7e89\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"00932fd6b95f0525\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"970b3acf51f9baec\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"067d262a85bc2fac\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"9b9c7250e97c9a1d\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"26300f679c2ac43b\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"5c638d0911231ef3\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"33cae9a0ef04233c\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"2751ef3800e2cfea\",\"/knowledge-medium/src/components/renderer/BlockReadText.js\":\"b5b921f93633b0de\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"64a6d397f762e4d8\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"31a09242cc4054e7\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"23f6790b6e86b7cd\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"d65b4d468790c336\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"05e99ffb67991dcc\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"93a0039e1d08d29e\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"f5ee333b22aed501\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"9cca44320c6845fe\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"26a7d4a7c8be12b7\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"87119b69bc604202\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"a5b8c792e8e851e3\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"f6704bfc06d41d8c\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"6b22d25d0e244b8d\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"c672107e7e073d79\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"e74e693a7288d135\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"57b72f00ac318fb4\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"d4ff3b1981a40dd9\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"4bc7c4ec012096a4\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"31fbd84d09043ad1\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"1832464dfd05472c\",\"/knowledge-medium/src/components/ui/button.js\":\"29871a14a79c34c7\",\"/knowledge-medium/src/components/ui/card.js\":\"b792d6800c487f67\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"8b4af81c66e52246\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"f8c04a1ea3f70412\",\"/knowledge-medium/src/components/ui/command.js\":\"bd3474a094f8f97b\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"456b127afe781f96\",\"/knowledge-medium/src/components/ui/dialog.js\":\"27209fae2145d478\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"1f5afe948521fd33\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"42b659c49ab5acc6\",\"/knowledge-medium/src/components/ui/index.js\":\"a98f20fe657e74a0\",\"/knowledge-medium/src/components/ui/input.js\":\"2170324f54d66864\",\"/knowledge-medium/src/components/ui/kbd.js\":\"073e9e571dc6c564\",\"/knowledge-medium/src/components/ui/label.js\":\"7231960663838807\",\"/knowledge-medium/src/components/ui/textarea.js\":\"b58fda7c1153745e\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"4d5713837c06e401\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"132c32f3122c244d\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"113b828368b377d0\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"13f2cf1ebdc5c395\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"b4b9a6da31c49be8\",\"/knowledge-medium/src/components/util/error.js\":\"a2932fc0bd3a6833\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"def15baeb57ea49c\",\"/knowledge-medium/src/components/util/suspense.js\":\"942220169e25afa6\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"406dc3a404f79568\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"3ec39141d23ad353\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"43cf51897c5152b8\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"81890c094e50e640\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"52401c375280c142\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"d9d3b746bdd99ed3\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"67bb113841f18455\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"c5204b393ad4e912\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"6e670fa05ff9c6af\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"47e8e9b86e365b61\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"9a07a37b0c9d41f8\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"734ac5ce36ec8af6\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"6cbb74489577f3a3\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"21dbac694934c396\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"06a7f2597cd9554a\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"23e99313419eb697\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"2be4ceff254a2961\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"6ce4b649e94ded11\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"40f718c114f817e0\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"1affef3657bd0663\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"b8b6313c4cd3b08c\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"afdf2585c16844d4\",\"/knowledge-medium/src/context/block.js\":\"ed4b903538d919bd\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"be0c6d0d79656c60\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"b2c281de4b9a9cff\",\"/knowledge-medium/src/context/repo.js\":\"8aae564046f52fe2\",\"/knowledge-medium/src/data/aliasClaim.js\":\"b9062de61a5cc940\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"157e6e24437abc5c\",\"/knowledge-medium/src/data/api/blockData.js\":\"b42fecd3d3c2d454\",\"/knowledge-medium/src/data/api/blockType.js\":\"02a55234fba089bd\",\"/knowledge-medium/src/data/api/changeScope.js\":\"8ada351fd78c47ab\",\"/knowledge-medium/src/data/api/codecs.js\":\"022879301e63ebca\",\"/knowledge-medium/src/data/api/derivedData.js\":\"41b590cc0fb40211\",\"/knowledge-medium/src/data/api/errors.js\":\"bc01fc7e418b61a4\",\"/knowledge-medium/src/data/api/events.js\":\"4dac7fd1c5369458\",\"/knowledge-medium/src/data/api/handle.js\":\"b1f4a55bc95dbe2f\",\"/knowledge-medium/src/data/api/index.js\":\"b41e088f2826f949\",\"/knowledge-medium/src/data/api/mutator.js\":\"f45b04c6137090fe\",\"/knowledge-medium/src/data/api/processor.js\":\"03e6e0fd7c50b411\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"26023eda5eef012b\",\"/knowledge-medium/src/data/api/query.js\":\"04376ab447046bc0\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"42aa21d92d289abb\",\"/knowledge-medium/src/data/api/schema.js\":\"b1f4a55bc95dbe2f\",\"/knowledge-medium/src/data/api/tx.js\":\"b1f4a55bc95dbe2f\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"63e765a9999ed394\",\"/knowledge-medium/src/data/api/user.js\":\"842cfd66fd16cb3e\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"36a028715ebb729e\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"bf8b4781138328c3\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"d4b2300b2cbb66b6\",\"/knowledge-medium/src/data/block.js\":\"0a237ff4ee709819\",\"/knowledge-medium/src/data/blockCache.js\":\"e2eec2aac90911ac\",\"/knowledge-medium/src/data/blockId.js\":\"f51edc74ac62b56b\",\"/knowledge-medium/src/data/blockLiveness.js\":\"77d6d87c89fab4a5\",\"/knowledge-medium/src/data/blockMerge.js\":\"a13ab1157374936c\",\"/knowledge-medium/src/data/blockSchema.js\":\"9149c3ecf6a282ab\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"78e3c23262425a1b\",\"/knowledge-medium/src/data/blockTypes.js\":\"bdb3f26dd4463692\",\"/knowledge-medium/src/data/childrenView.js\":\"531c52e66a04c3dc\",\"/knowledge-medium/src/data/clientContext.js\":\"d3be9b5b2f6dd743\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"f2509501ee5ddea7\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"6bab7936544e16a2\",\"/knowledge-medium/src/data/derivedIds.js\":\"0585cc280b3221e8\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"7cfd7d0df8c7e964\",\"/knowledge-medium/src/data/facetBridge.js\":\"81f593220b8e0f52\",\"/knowledge-medium/src/data/facets.js\":\"bea2db5483451be7\",\"/knowledge-medium/src/data/globalState.js\":\"e4df83e1aed69b6b\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"d6a1360e57b89933\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"71cc86cb3a631714\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"a47cf8b3752dd7e5\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"f7d7c235359a6910\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"70dc722223135769\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"c11e3ebf966f2ec3\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"8766fe868bb13178\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"ab02d34a80c9bd09\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"b3e622620c7b479b\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"a347ad8fde3ff0c5\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"1d0f2ac54bb8acf4\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"28fc6c8f82bce6c6\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"e113166ca9ef0de9\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"ce22702f080d83b7\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"4d5828fb4c8de617\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"0e3b1759a2178e31\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"db1383da1276bf50\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"04038bd0fb6a7374\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"e09d797b903cc5a2\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"c71274d6d7214209\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"72a483082547fcff\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"191180cc89410704\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"9b94fb0b0df3fa63\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"1f8eff0799f21003\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"0ff5dd3010972e9b\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"8bd117fb1975739b\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"3445474cb4aff8c8\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"9a01a99cb3e3b184\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"582c8a79439d0208\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"20da2f0e4b9e12ec\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"ac1d9e0713e3b982\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"9d609d0b6caade1d\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"848059c36fd40228\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"77fe41a769cd4ca7\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"64405f9e6c12177d\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"557168e920bff7e2\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"74304094fe566cef\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"ca306fdf6039a445\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"31d9c7d78e4cea05\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"6f7dbcc8b6bb6401\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"6c6e305488715847\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"d7fdd47704d0f7ab\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"05ae22ad62e9fae0\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"8ce427df42c47a46\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"c1ee61605f0ac39f\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"e9792ae5d6731a88\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"98b9199f219b8074\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"0fdb17393e82ab15\",\"/knowledge-medium/src/data/invalidation.js\":\"4b7bfa612c6d6ad0\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"f4f7497648dba842\",\"/knowledge-medium/src/data/kernelPage.js\":\"ce0c0134b5270428\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"0ae276958e335e6f\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"c24120804fd680cc\",\"/knowledge-medium/src/data/localDbStorage.js\":\"050ff501fe6a9309\",\"/knowledge-medium/src/data/localDbVfs.js\":\"6b93e7e857484844\",\"/knowledge-medium/src/data/localSchema.js\":\"76d705f6b989f49e\",\"/knowledge-medium/src/data/maintenance.js\":\"8f5c449edc48cf33\",\"/knowledge-medium/src/data/mergeProperties.js\":\"af498d59e14bc953\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"819570579f457c5d\",\"/knowledge-medium/src/data/migrationsPage.js\":\"952a8bc45571d88e\",\"/knowledge-medium/src/data/mutators.js\":\"0bb23a96cda36c0d\",\"/knowledge-medium/src/data/orderKey.js\":\"16b6065896aa775a\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"047d920c69c12ab1\",\"/knowledge-medium/src/data/outlineSurface.js\":\"0f52591ebde0d33a\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"4dc94cd922f20aea\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"0cf1991c2a377b69\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"6c4ab6facefeec56\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"8ae7fbe238c87314\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"2a08122a0b383b2b\",\"/knowledge-medium/src/data/properties.js\":\"4e72beb96fbc4cb8\",\"/knowledge-medium/src/data/propertiesPage.js\":\"2805f375759bc468\",\"/knowledge-medium/src/data/propertyChildren.js\":\"55f0d066dcb305ae\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"34978fcc5431b800\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"673763d13a07c55f\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"d6113453d9c409e5\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"ade438eed098462e\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"4f34e07cd2da2fe6\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"e01a2dc99588cc29\",\"/knowledge-medium/src/data/propertySeeds.js\":\"2bf083cc7d8de1c8\",\"/knowledge-medium/src/data/recentsPage.js\":\"b5230ec8ce7c4f61\",\"/knowledge-medium/src/data/refTargetComparableProperty.js\":\"35fb0565f372ace6\",\"/knowledge-medium/src/data/referenceBlock.js\":\"74118bef31127c53\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"4507f5ed5f8454f0\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"68d3a6f6db4a9e86\",\"/knowledge-medium/src/data/repo.js\":\"3e2108fd20eec8c6\",\"/knowledge-medium/src/data/repoProvider.js\":\"e8708f1071c829c1\",\"/knowledge-medium/src/data/rowProperty.js\":\"0584d9bbc49d24e8\",\"/knowledge-medium/src/data/searchFilter.js\":\"8075fb0ff9e02b7b\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"2933cdbe1260923f\",\"/knowledge-medium/src/data/stateBlocks.js\":\"4749544b0c987cb1\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"070b0a56f72dfb30\",\"/knowledge-medium/src/data/structuralInsert.js\":\"cf9d77fc856f54f7\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"e7b155e64d5e72a4\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"f328eb7bcac0a227\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"d175e17b5b989d1b\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"500d4ca1e9587fba\",\"/knowledge-medium/src/data/targets.js\":\"1dbd09d8b758b868\",\"/knowledge-medium/src/data/typeColors.js\":\"8b675437c87c3103\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"afa027173c62b341\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"780039fc58936ef8\",\"/knowledge-medium/src/data/typeExtraction.js\":\"f304ea029d01b2ba\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"7e4c33a74bd3b563\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"86b900ac09659a9f\",\"/knowledge-medium/src/data/typeSeeds.js\":\"29b4db401269fccb\",\"/knowledge-medium/src/data/typeTagger.js\":\"68e48254a8674038\",\"/knowledge-medium/src/data/typedRecords.js\":\"ec865bedb0a07979\",\"/knowledge-medium/src/data/typesPage.js\":\"4f12f37e5bd6c88a\",\"/knowledge-medium/src/data/userPrefs.js\":\"c85c6a6a30a29f75\",\"/knowledge-medium/src/data/userSchemasService.js\":\"a696761473d983f1\",\"/knowledge-medium/src/data/userTypesService.js\":\"1d9759b11ceaf692\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"381548d0a1d65411\",\"/knowledge-medium/src/data/visibleChildren.js\":\"50900e8528117387\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"1b7518f7e49741cb\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"1e79eb8f9b443e1e\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"ec5e398d5aabb594\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"c188ed82aabb5222\",\"/knowledge-medium/src/data/workspaces.js\":\"d90a1d5a43daff68\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"3a05c8e3cff7c14f\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"751bbc77c7baef32\",\"/knowledge-medium/src/editor/atTrigger.js\":\"eeda69dffafe2932\",\"/knowledge-medium/src/editor/autocomplete.js\":\"81e2a2ea17050055\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"9089a73737649bb4\",\"/knowledge-medium/src/editor/contentFlush.js\":\"ce3c69135b338ec5\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"e7e0f19a486b1148\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"1f133b1ec6dfaeea\",\"/knowledge-medium/src/editor/insertImage.js\":\"99b6434bb96e08b7\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"8d1ad74e01ccb680\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"5ce3af7b99815387\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"3778e077fb79c277\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"f882b20ff55db58e\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"5aedd8e8948d24af\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"4294921883ec4504\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"2a7c305d7c6cc7b2\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"0bbf01f9a724fa35\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"678ce4b7e155a5fd\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"19ab293d1866fdd2\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"83fe040bcdaa8a7f\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"2681a7fb979c17ad\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"b0502b46baaeb97d\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"cae3280edf3b3fd1\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"7359329186d99f85\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"629cd1600f4ac3be\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"14f2fa83bc2d1706\",\"/knowledge-medium/src/extensions/core.js\":\"8fe753b47d2eb950\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"d0b001f759b574d8\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"3e96742d4387ad9f\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"5125908f2c304eaa\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"e430199fac9f0678\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"1fd63a1aa43f01c0\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"e14150568439db68\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"1866f2a3c89cdbe9\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"2930248a0ffd9804\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"23ceca45f7ab9769\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"aca2dbf4a17831e4\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"f713071843dd1bee\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"39b33a7c540ba06b\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"09b6aa19792174b8\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"8a505601c7c16f79\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"30fa5470eca85ec8\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"22bd8a69266b08bf\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"b34bc931996b997d\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"0a7b417c3cf143c8\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"b65b2ee2dd181339\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"5899437ddd2ae648\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"adef9c6fcd208e12\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"bfb65e0d2b9ab17e\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"58f18d46b456be5a\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"61cbc9d28a9655b9\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"a418b735ff5aac25\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"7445ced2031bb09f\",\"/knowledge-medium/src/facets/facet.js\":\"36eae8f209bb6866\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"02a5d26d889ba310\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"37e80c183849dbec\",\"/knowledge-medium/src/facets/togglable.js\":\"e2eb9298fad46fb0\",\"/knowledge-medium/src/facets/variantFacet.js\":\"d0a8586a84407ceb\",\"/knowledge-medium/src/facets/verbFacet.js\":\"2f7987eebbbb0616\",\"/knowledge-medium/src/hooks/block.js\":\"973d6c4521735ae4\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"918744e488ad8d6c\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"fb8ce1dafb091be7\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"cbcdcd0c68b122b5\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"3180595a6d91ae3d\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"34de647d5f24dee8\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"6ca8dbe4bc702ee2\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"7f03f2a8fa4b1ab5\",\"/knowledge-medium/src/hooks/useFacetValue.js\":\"6309a409b1750608\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"faa0f0c6d131b172\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"22ff5d1473ce3c50\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"ba0df1385dc65468\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"afb47dab9211e95d\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"78e11fdbf5528e96\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"0f3b2c08fb19d96f\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"828b9050f98becae\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"387bdd623bb996bb\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"3565c3ea8cce9079\",\"/knowledge-medium/src/lib/utils.js\":\"9e554dc243be2def\",\"/knowledge-medium/src/main.js\":\"c92095f59715b0cb\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"e3f7bc76841a2de0\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"02c5d0be67ca9c28\",\"/knowledge-medium/src/markdown/context.js\":\"5f8e13cd4650a689\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"f4f94b7b1aa92243\",\"/knowledge-medium/src/markdown/extensions.js\":\"4cf1be0e2a901879\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"54e1ef93085d9be5\",\"/knowledge-medium/src/minimal-editor.js\":\"9cb430eac4c24955\",\"/knowledge-medium/src/paste/armedCut.js\":\"a0c947ca7a23ec70\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"d67566752932fda4\",\"/knowledge-medium/src/paste/clipboard.js\":\"0c0cc6a97bb7683a\",\"/knowledge-medium/src/paste/decision.js\":\"af68ec4aa2e8d6ac\",\"/knowledge-medium/src/paste/operations.js\":\"86c52e45f8f432c4\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"9115216f32dabaa1\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"cbf9cebcba56e5ee\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"e6d07a538da2f75d\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"96751a2ead8a016c\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"7b904d55a7485395\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"5b180119ca71d431\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"5205bce89b5e8b15\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"3fea1446f97e7126\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"f157677f97837b08\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"c511ef10e4dd9d89\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"9477e7e2b1830f3b\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"dde40d41f9bb7b15\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"4e2652c4b653d478\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"87fc927afa734600\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"2edcc11d3a95c3c8\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"bac89bfd965e2227\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"a8d352285fd99532\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"c87223a90b8c5f3e\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"7e2adca19120e905\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"30f6053c968d0941\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"d7bd2ece69c1aaa0\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"f26db54f3cabf331\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"4a4bf829c5da9150\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"85745f37cf5cd4ca\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"a0bd55609c369dd2\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"ce4e81d30f82de79\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"95ce873a4cd7f35b\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"9737bc1c320b632c\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"eb8e0f6fd09d18ee\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"0381f8bcaf47f492\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"eeeebf19fd2eb1ff\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"97a839bddd89983a\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"e83e741f1399b936\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"a92d62b25a65c55e\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"0057138f46e103f2\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"6022ec2a78f31c57\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"7c55a0584b802713\",\"/knowledge-medium/src/plugins/agent-runtime/dayPropertyInputs.js\":\"6cb37118b0e5b965\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"e16acb38b6a6bc4a\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"5766299640d750fa\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"35a011c49e54a6db\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"68ce195fb581af6f\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"234918b77761a954\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"d0ee9274eafa649d\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"1e45f6a74d81e904\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"49157fb8221aa4b0\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"808af0958bb322c5\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"c9b7e013ecd9709a\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"df303ac9dfb9f5af\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"2caedab0e2f8753b\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"4acb43ffcfdaa15f\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"bf9c91e9971635b5\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"639c1c66516e6022\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"faca70a2d08a7584\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"58391e5839c03e1c\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"6c0b29e16567b015\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"103523c45f9dfdf3\",\"/knowledge-medium/src/plugins/alias/index.js\":\"5ba28a20fc7f4926\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"96fb68bd3b982d44\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"646fe33d9001bcd9\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"192c83fbdb40e51a\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"bbc497391193938d\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"d8aebf03ccb6cd5a\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"54b391e6ecf7f62a\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"1e1ae7fc6a8edb2e\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"58d7acc4ff646828\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"545cd76d1b965390\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"a0ad22298b7fb6bb\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"057922e2a002e60b\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"9223c080998d994c\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"de8e98fd274ed403\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"40985b4b369c35e5\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"1ac8c4a6d485e17d\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"9acc5f230eabd9a6\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"7ceec7f84f323ac2\",\"/knowledge-medium/src/plugins/annotations/marginAnchorLinks.js\":\"62dda447f7c12663\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"c398e513185e2756\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"f4ca2638a954d0bd\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"39fccb89363b0d28\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"234c31525a0b60e6\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"da1c8653d5ef338b\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"1ae281afbdfa3aae\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"feaadfcc94f4bbf7\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"3ba97732fecc221d\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"cd59a03d119494d4\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"f2a5830ba6a21121\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"591e8bd2d9abbcf5\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"eb3bcc157996635b\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"b62034f724bf7bea\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"8d1d0d3089d5b1cd\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"b96b12737754dbf2\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"d1a14bac8b7a9b3f\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"cd3cb1ad75e09970\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"62c78d90ceb866d8\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"8f5992d0c8cdd735\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"3d0f2f2e56fcdae3\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"de39cda786272c5d\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"71554358e06548e2\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"9729a5064adcd726\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"4981e2d4385cb4e7\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"ceafc6dad7d282fe\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"28bed4cf82a7ef72\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"ef77d0355411c467\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"b6e0fb3d3ad9b731\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"d6b6cb5b4aead782\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"99581ee76c9b5cae\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"9abecffe5c26129e\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"df6b19de7e17a432\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"4cbe2d2510dd0e52\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"7c147153cd021d6f\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"d5680bd63088bc19\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"164764a32d66c6dd\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"56fdea8ce576e966\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"51f730753d98ab7a\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"a7efb29bb4aaa3f1\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"25b0b4c256071a72\",\"/knowledge-medium/src/plugins/attachments/browserMedia.js\":\"c48b691313ee0d49\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"5545c2fd83907a59\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"edb6183dc0083b76\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"b3a98472cb75c121\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"5ef0f9560a18fb03\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"5e6fa01c09c1681a\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"ed14de0c5665a708\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"82bc9c67aa4e3a74\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"c8d5205654ac1842\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"96f7d5c15707b303\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"f4399e3d03d0cdea\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"9ccccc6b083baac1\",\"/knowledge-medium/src/plugins/attachments/mediaLanes.js\":\"69d38ed04c88cafa\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"2416b3b152fa6328\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"d6d7c9331b551824\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"f6b47a46b4ae791c\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"247f12a449e39557\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"6894f225e8572dc2\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"81d9f8c3976c266f\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"b1dcc5c6889cb2ec\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"06c450dccb176345\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"7f091194e55b685b\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"76e6d6a80ce8bd92\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"a25de1752857cfa5\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"4978a0738fc81745\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"f7a11a4d5364d4dc\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"e365bcc18e3c0646\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"809f39c8eb55bb8b\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"037c55d8bae13fd3\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"afe1295006a8264a\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"4bf90560bcd83f0c\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"ac8343deb52e938c\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"0052a946287094b6\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"8b13c6feebbc7d5f\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"2410f77b79f54e34\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"74799acce8c44470\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"4c04ce056cb66e2f\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"d74a3e98b62fdedf\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"0d16ecedec9e332e\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"353b3c96e2fe6c2a\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"1feb3af347d01edc\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"2d668f818c1d54cf\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"e106ce47b0caceb7\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"a1b800a20ee0f739\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"f7180d296ab4c564\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"265e0323a5d63247\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"fda63f6c315a2daf\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"10173498613ff722\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"0792a8bd2fbd00c6\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"4f08b7df30942378\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"4ace882af52c2b1a\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"20819fe76d8ab57c\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"933f8f01cc061fca\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"03489e86abc50d4f\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"db60528a39796ea8\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"36a8e20646813a49\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"40fc6a6ff6b99661\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"2c9303972e039b6f\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"a13ca66eb3a83198\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"b83963e7c73b5db2\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"5a587f8a24951fcd\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"eaff8d786b36dba1\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"7308bc783fdb9053\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"7f35907058277439\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"039e1999a6b3bd68\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"60950fb8e9b034aa\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"da1e4588add8b33d\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"f9e1eae49c557d0c\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"fa812b1aaf3fe1d9\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"41ab49b24e0f5511\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"7a212f2faa110333\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"8a49e2c51fd0b60e\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"8918eff5928e6555\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"04524f0cf3bc52fe\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"f52142a69f68f093\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"98756ac830b6e2a0\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"c83707939739862a\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"3b84b729fbb6edc7\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"f302b5bd10faad8d\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"2c8e6efffd422681\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"027e6f13b7047ec5\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"02a30e30d0ffca12\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"6923ad2406a90d3c\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"7096253182f72d61\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"6899e25d3dfa3b02\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"ff6b72affc81fc67\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"c615e3ea5b7e8b07\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"7c254c70457f398e\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"33a11e0edca20779\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"3b622602a2ed98ba\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"d2ac29e738f1c54a\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"61280a4bddd49faf\",\"/knowledge-medium/src/plugins/character-counter/subtree.js\":\"49ebcda09153c30d\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"83401ff909c77762\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"4c687d1a146596bf\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"86e5a2b3eee253a2\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"f1eff9fa43a959ae\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"e9529c53eb32451a\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"f52927a2018e687b\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"8cb4a9cc816d78f5\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"043dd892f9943bdb\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"a42d716181180446\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"f806b84e1f9cd0c6\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"bc4490d4a6cdf8c5\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"6b922d3a0b010e9c\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"90127dc35b8202e4\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"173ee9a10fe6248d\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"cc783bf49d0af2ca\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"7a0cc1c0e10a6026\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"c70dad62126e6638\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"ccdecf31ff64c5ff\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"e0f59a954f30af3b\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"89039635f3f4bf0c\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"7eeab7c4e37ba545\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"fb1c373b1371e6ba\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"12d9d7933b190321\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"808e7953155e8cfa\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"de0c68bb332927d2\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"8d2162b94b7ad182\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"8744d8e5b7ee1224\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"45e0422d80cf1476\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"09f11b4722d626f9\",\"/knowledge-medium/src/plugins/daily-notes/DayPropertyControl.js\":\"d51258a71a6e3b04\",\"/knowledge-medium/src/plugins/daily-notes/DayValueReferenceControl.js\":\"e8d0ab6d0f6bbbd2\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"3e021c1a746dde84\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"7348d752f0a811ae\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"93cc5c002e786880\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"094d16a87e52307d\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"1600c1b0395619e3\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"f1a1376e4e6a7fb2\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"ce10c93886a0b2fe\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"d098c5494acd74a1\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"5434113ca659a154\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"3fcdd48b33b06b5e\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"086be1b61eaf596a\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"4df2a92cf66a2e01\",\"/knowledge-medium/src/plugins/daily-notes/dayProperty.js\":\"673c7b182b073ebb\",\"/knowledge-medium/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"cd74494292786579\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"652739835b91887b\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"c01464a2b28a3341\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"5f4d37233474619b\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"9953fe39852bce31\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"079a5ad5bdf1ede2\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"b72de85f49875558\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"0ef2194945bc941f\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"8f6bcfab0b027ebd\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"5e67b23ad32f8e98\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"649498bb624f30e2\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"8b1868314fc64571\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"381a913abb8b313e\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"e66e297c15604d4e\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"6f98448153b06450\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"7cfbef797e348234\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"59785f0ed80207e9\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"8c34efe3264d02f1\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"998b56cbaaf4345c\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"42e6fca71a34977b\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"fbc29c3678220625\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"f1eda19b9fc7b9a9\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"aa3a0f6f98419733\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"381f47b9e7fe69bc\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"8f95319fa1873812\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"88442c57d9a0fa4d\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"41db60b5d499dc7f\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"e6a7e4d873adcdf2\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"87a1a6ba2436aa63\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"1cd9155f71a84765\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"f27a7ae510f7ce51\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"51223c8780ffc23a\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"f89c03648a05afbe\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"859c19e5803aac51\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"b70a7a507e9a621d\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"e505941c2ca4e8ea\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"a646c9924a67caeb\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"648f67f0341f4c8e\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"95530746fd35b3cd\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"4ae8fce9549f8c37\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"bc6852691b74fb4e\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"b68b0d584ae142be\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"5782d31bc1e3791a\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"738c26ebe21a7221\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"dc6971d57b5d9f6e\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"87521b9b75070c76\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"c22f94e6b9a005ba\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"79d21baebfaf057f\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"147c14c41a428f31\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"27551875736a2aa1\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"5b602491ad76c2a8\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"17a0adbf05bf7592\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"5a4301669ec68de7\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"bef9ec67c894e8a5\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"70451c5e8bcf22f3\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"bb2ac2a010dded14\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"47eb843f1754486c\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"b9362d0f46c01697\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"0d525bc2d40643f9\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"318f20994e7fe645\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"b3d71d73b4e3ca95\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"2d36c6c41190adb3\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"721c7082dd1a79e9\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"6b27242e400cc88c\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"2bfd91e63808e036\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"7a323e8c875710b4\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"e92ceb0cf763d7cb\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"bb228f9f2bed1459\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"bbfcb0a5af5860c1\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"25865dc62e0ba32e\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"239950198d68a8d9\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"4bb55e4f9686e3f7\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"b24a8d6a9e761668\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"e2ed26aa2b56cd1f\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"0db665d7b541ac7f\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"881f25d1f11ace7a\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"c856b07442987b24\",\"/knowledge-medium/src/plugins/geo/index.js\":\"191cbedd2ef14dea\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"85b6775fd307e960\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"54a7bcff257a5e23\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"fae760bdc1282bae\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"24ade486e77e7eca\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"982d3d9f7a4affe9\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"4d56195c10b34d5d\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"a1ddd5837adad9ca\",\"/knowledge-medium/src/plugins/geo/query.js\":\"27a9d3bd73e74c87\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"0619f94af83e757f\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"30b513e14fdd9e61\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"92d942e7f0c4acd3\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"7dd30c21f627162c\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"9fcbd78078deab05\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"bfc50254973733d4\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"3009e0bede1a5f37\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"b885abfe0f6ac5e4\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"a303dd93aa07a096\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"da1a2668d6823a2e\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"9bddd2494eae61d4\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"ed5088c534684e31\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"d1553a2f9edf4d39\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"679c22186c712d1b\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"fd3eb0fd4afba9a5\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"e4a40e09129623c6\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"004f48c16a38c07a\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"307b567c41a382a0\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"65222107a1739187\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"d2d239bd28708f11\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"7b30c561e7518894\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"530e697814a6d36f\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"45c79d5f05ed3538\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"62814e47f166c35b\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"7b22d3aaac27e3e4\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"8c4e2598e1ca24ff\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"45cbbff182445304\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"bcf0a5ed69540e4c\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"a9974a44cb73a99f\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"6fdd501c8a5129a6\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"d514586bca0d840e\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"63d6c54d11e35e81\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"9dbb3a00df0ecf27\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"e3da66cea99411c3\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"e00a7bb49e9f2c2a\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"e15e0aa71d559f04\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"ad81b9e15b2280df\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"e108e05abc4b4926\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"8099ca3651c8dd95\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"b2ac6a10cb412551\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"4992500352827f9b\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"9705f4ff5104fdf1\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"d2bb14c844644672\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"d56bbbf6a5b45e77\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"2822963b84cdd655\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"b695195dd2d22d24\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"9ca01272f6b5a363\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"f7610008d383ed59\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"dc705f51b022a465\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"c3cf549771b57f10\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"45162670ef7ddef6\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"2defcb79a20d7792\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"fbd827531c808bfc\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"82c014c263159d42\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"eeba14c7e9131f8b\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"2e81b64f8be92952\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"452557e7e0ffa9a3\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"9112efbb915525c5\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"299eb54885e6a6df\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"5c8cdc9e5720ad3d\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"98213f022209eb40\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"c50b2c7fc3b98e7f\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"393e17c6b7d6c8d0\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"6628a953c75b76ed\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"c2e772c67d095030\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"5ad2eff989b0008a\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"ecce8bb138687fe0\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"88a9c649e666eeaf\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"db0bf9d6deb30546\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"85b09d18ce3eaa83\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"f9075a15f4202a7b\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"a1e7ff3a64fe7052\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"b99b59f7728a44a8\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"e97b0e4a3348ce46\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"f3d245827ad2a2dd\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"1ce9c17aeca80666\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"db08c2af01fe68ba\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"e156e822ee032d8d\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"5698150e757e7aaf\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"6c5e8020fdfb0c8f\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"a12ccab8cadad4fd\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"8709891a2bd45979\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"0222b83a906d1457\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"8d18cfe7c3c1c97f\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"bddc46cba23bcef2\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"8e2393e99322ffb9\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"32ce366f9d03bfcb\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"0c1284598e9e7241\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"e1fa56ced6666d65\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"b1cc21c08ecbbb63\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"edcfb87c26f851d8\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"1c399f43d70e8250\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"37c7d1432c3ba576\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"19f96bb2392793b0\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"b21777a812457434\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"33f33d5cd8aed686\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"37ecb8c2ccc21edb\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"6d11c42b2f254c92\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"f00b7d20bb702f2c\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"34e4a72094828b70\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"d5a873d94f4f06f4\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"b89a168386bc67f2\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"80e7358063547f91\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"b2606fc72cf3e114\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"79e86dd53d185ca7\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"38c3c06f4093097b\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"e77f990937545251\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"3c205453965b6c70\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"805e39681abc87f4\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"17aa1dfc57469720\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"a1603bea0cba0c9f\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"889eadd32719aa2c\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"c80f50d7f1cad104\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"c39a3948ee52a069\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"a2451ea5a978961f\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"82743a4a3a62e4f7\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"858960913730ffa5\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"1b5816feda0b9104\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"fa4e44da2eb719fe\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"44c8b49aa4a308b8\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"4d0d0aa4c9c1ac97\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"37a1e022583bda24\",\"/knowledge-medium/src/plugins/recents/index.js\":\"8b1022ebbd13c197\",\"/knowledge-medium/src/plugins/recents/target.js\":\"90699e4a9b20a821\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"3049409d486455f9\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"5cb1722bee6a8185\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"84ee954a75abccba\",\"/knowledge-medium/src/plugins/references/index.js\":\"884a7d39d05fe392\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"7d8f252e66ff6b3e\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"789b3a7e772525e3\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"713c7649af840a26\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"d33c29cc679b2164\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"c7f53b1ccebf8914\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"97274109de06da72\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"acf10ae519c87850\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"d229db21b03b5e15\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"af680ccddd2b1536\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"45beb21b3bae8e32\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"2ea07ad668cb02af\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"74ddc06a0294a81e\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"448f7535e5446829\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"cdee7a4fd159e21d\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"d0371b145cdb0734\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"b9014bc692958366\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"92a8edfa95455af5\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"7e37dae818f7000d\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"4de1096b88dd8305\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"d5ba7cb33e6d8033\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"7a5f12c276497db3\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"e5dbd2f2c4fa0d22\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"1e736d11828e6646\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"3f58f497343ebaf1\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"41598479caa89dbb\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"72180eeee887efd0\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"36d416eb684fd203\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"734a6dafe855603e\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"17ddf60ddbf9b3d3\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"7095e6e6bb14e01a\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"95eb601b721e8813\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"8f04dd198c0f9955\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"d22ac405284a70f3\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"b2147b54972dba25\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"717d8d1372ee3009\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"50b53e8bd79b04d7\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"32e91e6154482dd7\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"de1bdbbf4aa2155e\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"42105c0ab423ce10\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"4b657ea13b8c3069\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"3d5a5624950dd44f\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"b7a70e4f51b99965\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"197e81ff4bc929da\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"886709a086cc318e\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"536bffcd3656c04e\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"494ea43c6ed6884d\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"994a60c2a7b0fd25\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"97d058a4da21849f\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"5ab1a04391539d69\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"a252abbd51946e5f\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"5e9b7bd9c2420ee3\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"cad3eab2c017e49c\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"d8e027799b609bbd\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"2ba394851c5de313\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"4c62fc359f70bdc7\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"ad9c90dcf7366c72\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"60ad9c41975fd376\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"3851217c59531352\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"97173598c7513053\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"8df484b5204348f3\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"272657d7d4cbcc18\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"8bccb2f5e08ddbbf\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"09a584ad114ebd29\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"12a78457dc8479e7\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"9d3415951a4f9d44\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"08aff7ae0d4b287b\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"65bf61081be0fcd3\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"a6788e955772dcc1\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"dd0d886887bc0a53\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"600e156ab359d1c1\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"126a5fc5b7a0d853\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"7d1aa1fceb924683\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"60c84c4f2a844fdb\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"b338b4bd3a65b092\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"c89634e2a3a46fa2\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"495e985e162906bc\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"f7487afddf4ca7ed\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"60226f943eae0aee\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"a5d6b8df83c1c8d0\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"a0c26bfd3b541d3e\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"e73ba3f4cff6c11a\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"3e1925fa98fa2742\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"bebc2ea51e6320f4\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"e79f06751aff473d\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"1b014ba5447920ce\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"f856021edb773907\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"4ea20fbaa26605dc\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"f16a6cb98010accd\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"35832239dd403208\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"c71207f9f159806c\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"347670cd99318bc6\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"b28c07f33fa659b6\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"fe1fc8e8994d13d9\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"d24326a1058e5b06\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"7964dd2437cd6590\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"5071ec2930f3cfff\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"f63e6bb01ad61664\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"14f5881d524ee259\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"0f01fabdfa9570da\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"6225b1ef5bf2c964\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"9e63d6859af9d80c\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"340d588ddfb81774\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"a7dbc0cd11b1d4f5\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"43f1995169b8da93\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"3f486d9513c6edad\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"51cad0f7bb23d565\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"3faa80777b1eaedc\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"93b9ffec61ecd424\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"18bb811cc3be2924\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"9250efc14501de38\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"d40c047e19a0346d\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"07255381d1ca815a\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"6759cc1e6c570dbf\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"7346e18f3e22aacf\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"4ee208ad956badc3\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"ebac6f78eef21b50\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"61a500a01cc83029\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"347db978e75d49e0\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"54b4c9cdd4016f3b\",\"/knowledge-medium/src/plugins/tables/childrenViews.js\":\"d3e69ea806072307\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"9114a428218cd167\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"70f30e02dbddaa44\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"5399624948f9153c\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"ed5fe56d38ad2d4a\",\"/knowledge-medium/src/plugins/tables/index.js\":\"8f9fbae7288c1aa6\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"f74466c0ffa45529\",\"/knowledge-medium/src/plugins/tables/model.js\":\"17191501a71a2d84\",\"/knowledge-medium/src/plugins/tables/query/QueryText.js\":\"ef45adbba513e8f9\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"2926629e41064a71\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"95ec384ecad10bff\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"6ba7f080d246e0fb\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"1c1fe9df3dcc9e9e\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"a5355b5ed827a405\",\"/knowledge-medium/src/plugins/tables/query/registrations.js\":\"3dda6de4e3e68468\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"e2c545445dc05802\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"260881e6f0f3eb21\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"2df5ee925d239e87\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"4f6d5d3c239e6402\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"4722367ac6c92e07\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"ea24680f73e86b6e\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"85807a9758fec4ae\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"5cdab64ceb13d89e\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"9f02d873c339d4f7\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"cbdf24487c96fdb1\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"ce1aa32c59ffa7e9\",\"/knowledge-medium/src/plugins/todo/index.js\":\"5f60095178d91c2a\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"9b00f070c3f3fe5e\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"8f05c7e45c8bccf2\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"75c6c5a24e30f82b\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"15016e0f4d94ba85\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"ed15259690e8c62f\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"e5e6112b79999435\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"093fd804694da20e\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"77a8cec89ba5906f\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"9ef776f7b02f5c53\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"8cc862f1e215ae06\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"385e5660dab693f9\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"731bfbb3e6b80592\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"c291576ceeb82c70\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"d98cc7a0e15240ce\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"7450e2545ad78a38\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"8a47d39d96ff96ed\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"d4a395a34f535b54\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"8596ac5de87757e0\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"147c255f651e9a03\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"f8af7acf6f5b290f\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"9aad98d3085ca94b\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"72fc43db0ee96d92\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"585e5130ad06c21a\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"a64fa3e342dda504\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"41f4ba1d9b26726d\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"f19ec03c68cf5f93\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"49c1b66f33c1306b\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"f7e29b8912cd35d9\",\"/knowledge-medium/src/registerServiceWorker.js\":\"1a947cd927a0e2a3\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"aa07051945f5bc72\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"512d169001cb88de\",\"/knowledge-medium/src/services/authStorage.js\":\"e0899b7d9381a5ac\",\"/knowledge-medium/src/services/powersync.js\":\"0b3be781cfc5f366\",\"/knowledge-medium/src/services/supabase.js\":\"8c597fd93e456d00\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"978b9e58f3521f30\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"3f44991fb6ba67f7\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"3a16aae0c6955764\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"4bf52b2f004f9631\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"1b72b79130b44d70\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"b804fac8d5c06162\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"5c99d2b78bc92c24\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"5b9b0ccf1bf0c52f\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"455af85976d466a2\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"291bb6ff86d8f394\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"08da793ee086bc48\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"6841f23f851d2a56\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"89b4f155dfd517a8\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"fcef25162bfb6f8a\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"67e435dfe3d99438\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"104f267bf2f93ff2\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"e6a291d1d3847f7c\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"43ee8827a916b88b\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"d507e58b186ad96f\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"9ec5be0c4c3d7a20\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"8c4490b8823cb0a2\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"8cf7578f1cbbfdd5\",\"/knowledge-medium/src/shortcuts/types.js\":\"a46aaadddd7e6ae4\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"9fb4f5ef1445fd47\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"83b7fe06417f1373\",\"/knowledge-medium/src/shortcuts/utils.js\":\"b48c6f5da0403380\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"c4d5b2e962539dba\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"f58c00b66f04cef6\",\"/knowledge-medium/src/sync/byteTransform.js\":\"b3cd13dadfbf822e\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"0f50876a5dc355d6\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"90ec0ed19f85c19d\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"fd4dbbb796201b0b\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"580f3d609f8ce360\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"4b7cffb8237ad2df\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"4a2d6d3112234fa8\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"bcce062ba9f097a3\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"768bb95650223246\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"95c057f242344a98\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"09fdcc375f7d8d7b\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"dc0aa83d545a55bb\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"430d646719600599\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"4dc5fb09caf72823\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"4ca1c8e37fd2c480\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"0fcc1f9ce117dfad\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"1de8996fdc4dd224\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"5a92736fceeee811\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"f44c0ec10aea0228\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"68e51c36ebdb6c83\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"0f8b4e5c62c53684\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"897aa8cc5153c010\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"64eb44d4bee657fe\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"a83d5d36f8c35421\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"5eb7d596a0c9a303\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"84d7bfe3b7363cb2\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"7d526ff0a3a2d3d9\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"b36d706050c35bc1\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"fd86dd4ee8bedebc\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"da9c12119c0b8e3f\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"ee76c75320167ee0\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"bc52e54f17d33d43\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"fb8158483a6cadc8\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"5ae553dd40407502\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"cf28df34aa617190\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"190702713e7e5b95\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"0f8dfdec962244b2\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"87ab768ece92e462\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"dd5b9871fe52b4a9\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"e8d705d532411ce5\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"999ba9a6e9be34dc\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"f543f5ff314c5743\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"f3bd14245c9e0a4a\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"54d462d2fcfadcf3\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"212c3ee91fffb5f7\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"0b35d563cfe2429d\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"4f1ca00b63150c47\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"218fcad603faf8c2\",\"/knowledge-medium/src/sync/transform.js\":\"0dc7af9af8cb47f4\",\"/knowledge-medium/src/themeBootDefaults.js\":\"101acbaefdd5ae17\",\"/knowledge-medium/src/types.js\":\"2a7d41ac754b5bfc\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"2c034be8c1d49085\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"e028ad636d88e36e\",\"/knowledge-medium/src/utils/array.js\":\"8bd5b3852f4a91a1\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"b3d70885f8ac576f\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"53693169afafbb42\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"0b32632240e0bdbc\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"0e3cfa8e9e3b50ec\",\"/knowledge-medium/src/utils/callbackSet.js\":\"3c0f77a2d54bd9a7\",\"/knowledge-medium/src/utils/clientId.js\":\"39cb52896e1e6465\",\"/knowledge-medium/src/utils/codemirror.js\":\"f68139239357e0e2\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"db94c2a1ae6d75df\",\"/knowledge-medium/src/utils/copy.js\":\"e65e577b0ea9e50b\",\"/knowledge-medium/src/utils/dailyPage.js\":\"c3719a5aaf7d30b8\",\"/knowledge-medium/src/utils/dbForensics.js\":\"107a7f473c39b858\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"8dfe2037512a0524\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"8268807376b80aa0\",\"/knowledge-medium/src/utils/dialogs.js\":\"d2fbf48edbf9ca07\",\"/knowledge-medium/src/utils/dom.js\":\"0eba324232d040db\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"fd61bbabf8ed131d\",\"/knowledge-medium/src/utils/drawnWalk.js\":\"7784f0157c79cb94\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"e0a9cc6f4949b492\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"e68f48f383903f84\",\"/knowledge-medium/src/utils/flipSlide.js\":\"223376f3c7fb4629\",\"/knowledge-medium/src/utils/fnv1a.js\":\"86de9369c47d2c8d\",\"/knowledge-medium/src/utils/formatBytes.js\":\"a8af034162250553\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"14e76dca53c6c290\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"c7d0bea32a42b152\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"ca1c4cefd115cc90\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"b7dfe9d4cd9cb1f4\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"a8ee00ef436d4aa9\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"cdb8831f45159794\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"90d0ee7ad9930c53\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"e0b92fa03816c442\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"218f9dfaad0fb2b1\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"425b68727997e636\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"7b161a9f4203dabd\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"653eaa968df5dd52\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"259121dbe552261b\",\"/knowledge-medium/src/utils/markdownParser.js\":\"3206e1528e0011e5\",\"/knowledge-medium/src/utils/memoize.js\":\"28c365ad43ba48d2\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"8dfd9a4f93d8b0fa\",\"/knowledge-medium/src/utils/nameList.js\":\"f9ca6526c20b8409\",\"/knowledge-medium/src/utils/navigation.js\":\"d761dd56585e2b9a\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"6e60ad9affef2d01\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"3ea37b64fd9ea1fa\",\"/knowledge-medium/src/utils/panelClearance.js\":\"a772c422c5488b4d\",\"/knowledge-medium/src/utils/panelHistory.js\":\"0fd135677559c08d\",\"/knowledge-medium/src/utils/panelLanes.js\":\"b1d72e23e903fd25\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"2b81235ebad7e3b6\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"fbd36e9f79778b8c\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"1e72abfbf2dc3f33\",\"/knowledge-medium/src/utils/platform.js\":\"6272b3025072e22d\",\"/knowledge-medium/src/utils/pluralize.js\":\"1d542692c410959a\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"48d81de496ed7e96\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"51869794e9b33002\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"274d957c6aace619\",\"/knowledge-medium/src/utils/react.js\":\"a63f8b4e441ceafb\",\"/knowledge-medium/src/utils/relativeDate.js\":\"d3b959f3e16602ab\",\"/knowledge-medium/src/utils/relativeTime.js\":\"5d239ec6269b5b64\",\"/knowledge-medium/src/utils/renderScope.js\":\"c7eaa31e2d89de31\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"0491c02b73af95a7\",\"/knowledge-medium/src/utils/routing.js\":\"d029395dab49f9c1\",\"/knowledge-medium/src/utils/safeMode.js\":\"b35d85e8c964f3b9\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"7aabda4981da3472\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"5fca5a8ad9db4cc6\",\"/knowledge-medium/src/utils/selection.js\":\"e0b03b7ec681406d\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"63c461ed324285c4\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"b41d0496298dae20\",\"/knowledge-medium/src/utils/state.js\":\"3ed2305c649e0e0c\",\"/knowledge-medium/src/utils/string.js\":\"b3897b3ca71ad48f\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"ac2a8e7b3a765168\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"ffac191731bae077\",\"/knowledge-medium/src/utils/toast.js\":\"4a1f30b6d6f2b345\",\"/knowledge-medium/src/utils/toggleStore.js\":\"67989003ad4ec3a8\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"a3f3b5f953e0d5e9\",\"/knowledge-medium/src/utils/userActivity.js\":\"3e8afde4a2daf807\",\"/knowledge-medium/src/utils/viewTransition.js\":\"b9faea15661f511c\",\"/knowledge-medium/src/utils/viewport.js\":\"2b0fe00c7d4b0e31\",\"/knowledge-medium/src/utils/webLock.js\":\"ff367f590a27ab46\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"b9c07451c33db78e\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"05b261193a84ecca\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"a82fa74eed9300b9\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"b2ec03e9ff979c8b\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"84c94bdc1db4553f\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"020b36d1eeb713d9\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"d998f7bd71e8b3e4\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"9d63f3dc7433d79f\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"4ef50ae07d433901\",\"/knowledge-medium/src/vendor/react-dom.js\":\"58cda231dc7acf9a\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"c6a7a2e3b1caa6f2\",\"/knowledge-medium/src/vendor/react.js\":\"47be627e26f8f0f0\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
