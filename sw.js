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
		buildId: "4072a6f0effd-308b5ddc",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"21db1a2a0ce9bc10\",\"/knowledge-medium/index.html\":\"21db1a2a0ce9bc10\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"46aa4a91bcaa9cf6\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-Ck19j1Y9.js\":\"8584afc766ab39b6\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"cf0c4f0ea3b4344e\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-CCrSdN71.js\":\"50491679f80f5f13\",\"/knowledge-medium/chunks/FacadeVFS-u81S5ocq.js\":\"793889b7e0f7cba9\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-BnROYZMO.js\":\"fe55e2d9dad91fa3\",\"/knowledge-medium/chunks/MemoryVFS-BHiCTzBv.js\":\"3329f55a504764d0\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-DIxb67Bh.js\":\"dc18d5f52f23e055\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-BSR8Paqs.js\":\"ef3cdd51513a16e4\",\"/knowledge-medium/chunks/Preview-CLNjbRbP.js\":\"139dfb411716761d\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-BBZRwpsr.js\":\"d7054ddcd02a35f1\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BhNQKDvy.js\":\"912c15a13d6c77c8\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-3AjuHI_L.js\":\"31fdd4f83db96590\",\"/knowledge-medium/chunks/react-78okiONB.js\":\"3b3c702374d505ed\",\"/knowledge-medium/chunks/react-B-i2h70R.js\":\"64c89d462291ae97\",\"/knowledge-medium/chunks/react-B1biUMyv.js\":\"4462d63737f2529a\",\"/knowledge-medium/chunks/react-BE7qt3I7.js\":\"f379ce9457e87495\",\"/knowledge-medium/chunks/react-D2JZLWs0.js\":\"5521c0ea8b355981\",\"/knowledge-medium/chunks/react-IRpU44QP.js\":\"17fd738c5879a1a5\",\"/knowledge-medium/chunks/react-JEE8TnZJ.js\":\"adc43115f706c946\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-BsMf29vs.js\":\"8f373190ad91cb4d\",\"/knowledge-medium/chunks/react-dom-server.browser.production-gglwB0bv.js\":\"7c874e4347403817\",\"/knowledge-medium/chunks/react-dom-server.edge.production-Dsh43iNF.js\":\"e0df3969ffd3773c\",\"/knowledge-medium/chunks/server.browser-B71CplyS.js\":\"fcabbc0bf96d80fb\",\"/knowledge-medium/chunks/textarea-99JvYrxl.js\":\"dc0374338ae94fb1\",\"/knowledge-medium/chunks/ui-B-F7PNb-.js\":\"4bf007dcdf6926f4\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"9257d34efe4fda85\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"20da6ebf25df8b55\",\"/knowledge-medium/src/appUpdate.js\":\"6e1ec33dfe23880a\",\"/knowledge-medium/src/appVersion.js\":\"eddba1e74421caff\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"45542efc1e495214\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"35f833d445d3bb74\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"227097745f7ca023\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"1939047b4d3e5835\",\"/knowledge-medium/src/components/BlockComponent.js\":\"273fe1d0a18321ff\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"b8d0b7ef3748e187\",\"/knowledge-medium/src/components/BlockEditor.js\":\"fda1e939853252ab\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"305e791692ec4aaa\",\"/knowledge-medium/src/components/BlockProperties.js\":\"92d2b76721afd1ab\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"1f473b44841f38bb\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"474dbd71fcc69fcb\",\"/knowledge-medium/src/components/DividerHandle.js\":\"cd014f396715b88f\",\"/knowledge-medium/src/components/DraftEditor.js\":\"0dc3ac3a5e68153b\",\"/knowledge-medium/src/components/GutterPill.js\":\"e03e1505221a533c\",\"/knowledge-medium/src/components/Header.js\":\"16d00be4fe8fcf98\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"f05252891deefed0\",\"/knowledge-medium/src/components/Login.js\":\"6e28c44e10dc739a\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"03a262499355cadf\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"c82756d61f9c13c1\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"99b48827b35f5b09\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"c9f8ab1ceb743e95\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"a624d2e0e06ccb76\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"a74112e04c4630a5\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"62b81ffb6c3923fc\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"515b6939acbfbfa2\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"28b3081530e17e68\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"5224667b60b2758d\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"2404875af0dfdeed\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"cb807402f6684e9e\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"0d74cd6a1626f37a\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"caf06f7f7f3f3df3\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"7ff0e6ec45f8258d\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"da82344a878edb8f\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"de0b0a156250569e\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"0cfb54b9acccaef1\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"b4373577794899ee\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"969e9aeb4f780182\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"0a713fdb1c65f946\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"ba521ff05373d136\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"7f60f2caada1650b\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"efe1e406ff9e7491\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"9144a699b236e654\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"e82a9250b925ab12\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"dded98e2cfd9e8e3\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"f85fb612f12b8f87\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"876fce274ab20f6f\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"6056f63fc9b1c00d\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"87080415402981eb\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"fdffaa7523ee76e7\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"919e0cd210c5bba2\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"1577d150c57f906b\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"ebd683e693c6216c\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"6d2deea061545b25\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"5cb26e49f2f333bd\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"60d046788f366b78\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"058f012cb5746cff\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"b8497d50f6a769f2\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"44ff918d659079f7\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"c6b22af720e3a363\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"fc3944231543232c\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"cc475da0747992ca\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"7837216905273042\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"56cd8d648590ddfb\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"55ce4b4f65d2a131\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"ffe38b7c2d6f39ce\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"532a90fe6f633a0b\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"12f85c74497033be\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"5a0f6d7288b0b0a2\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"9b7062651d6ad315\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"6471f032f58e5095\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"022fbcf39ed9d2e9\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"72023fde0de821b1\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"94b30441f9a8e3fe\",\"/knowledge-medium/src/components/ui/button.js\":\"b181131e06ff6aef\",\"/knowledge-medium/src/components/ui/card.js\":\"5c271799d416f63b\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"d891d79f0d67039f\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"b1a6b49e555c978e\",\"/knowledge-medium/src/components/ui/command.js\":\"a9683a4dc8445613\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"2650a940666f13d2\",\"/knowledge-medium/src/components/ui/dialog.js\":\"b37ec9e74dabf359\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"c33b7958ae83d6dd\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"32522c2879b084dd\",\"/knowledge-medium/src/components/ui/index.js\":\"6c01774961162a52\",\"/knowledge-medium/src/components/ui/input.js\":\"b4ad8ea233aa0615\",\"/knowledge-medium/src/components/ui/kbd.js\":\"bfd007a0d592e813\",\"/knowledge-medium/src/components/ui/label.js\":\"1d2fd94b7ec036e0\",\"/knowledge-medium/src/components/ui/textarea.js\":\"55eb47ad24ef4d45\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"e8e34fe61afa58f6\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"eaeb0788bd118667\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"7df1c4265be86261\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"86c4f8a6fe7c8bdb\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"10641d39acf26576\",\"/knowledge-medium/src/components/util/error.js\":\"be076006bbebcb68\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"0985bb01b6065efe\",\"/knowledge-medium/src/components/util/suspense.js\":\"99d11f72a19732aa\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"082d330ba197629b\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"568898115c418a28\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"85af6650bc6a135a\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"8e53f7541851281e\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"dc0f2417982f44fe\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"0e37c68a8e167314\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"c451ca3023e7e5a2\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"0c8896af1d5204bb\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"cb506499dbd0c858\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"c6c8b2f47170efcd\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"a4616f38d10d1f22\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"ec82dcb7f234a62d\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"ff5a840e0198389f\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"676dabd6d398b456\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"4da3569d51def7cf\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"26b962e4911987e6\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"3051083b503d9d87\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"d47958fd05234786\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"42e018b354943fe0\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"56ef58fb01bac088\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"da29a7a994f9281f\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"90c2674e1ddab0db\",\"/knowledge-medium/src/context/block.js\":\"f019e9b833f80012\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"f1eaa7dd22038d89\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"a5c14b8ea97635e1\",\"/knowledge-medium/src/context/repo.js\":\"12783f5b77417465\",\"/knowledge-medium/src/data/aliasClaim.js\":\"9d4a73507f4795f5\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"a9c4eec325ff3570\",\"/knowledge-medium/src/data/api/blockData.js\":\"2fccb1c3e3091673\",\"/knowledge-medium/src/data/api/blockType.js\":\"80be3d2872fb778b\",\"/knowledge-medium/src/data/api/changeScope.js\":\"643fa0e3f7ebb9c0\",\"/knowledge-medium/src/data/api/codecs.js\":\"20c16b39db8115f5\",\"/knowledge-medium/src/data/api/derivedData.js\":\"f470a1662d86cc52\",\"/knowledge-medium/src/data/api/errors.js\":\"d8046e58dc659735\",\"/knowledge-medium/src/data/api/events.js\":\"8fc1b801a3b7072d\",\"/knowledge-medium/src/data/api/handle.js\":\"d923ed48e0819ede\",\"/knowledge-medium/src/data/api/index.js\":\"8f3b5e91e291089b\",\"/knowledge-medium/src/data/api/mutator.js\":\"aff75c564323de72\",\"/knowledge-medium/src/data/api/processor.js\":\"802c5ddc2f7ec121\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"9845a004c892354d\",\"/knowledge-medium/src/data/api/query.js\":\"5c2e730de1299d32\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"1aa87c0bca5874c6\",\"/knowledge-medium/src/data/api/schema.js\":\"d923ed48e0819ede\",\"/knowledge-medium/src/data/api/tx.js\":\"d923ed48e0819ede\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"e9c7dbf660c17d14\",\"/knowledge-medium/src/data/api/user.js\":\"88575090e717a561\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"2daf89ea8e5ad4a4\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"0e852be1d5fe1c7e\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"b940cb0a017f6fa2\",\"/knowledge-medium/src/data/block.js\":\"e2cfce9360ab1bb5\",\"/knowledge-medium/src/data/blockCache.js\":\"6ba233bbe4f477e7\",\"/knowledge-medium/src/data/blockId.js\":\"42bdb52d11cbf122\",\"/knowledge-medium/src/data/blockLiveness.js\":\"ccc1347e3d1c04f0\",\"/knowledge-medium/src/data/blockMerge.js\":\"ed94fafd0a6969ee\",\"/knowledge-medium/src/data/blockSchema.js\":\"ca7aa072fe1afca6\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"e740ee375107ad48\",\"/knowledge-medium/src/data/blockTypes.js\":\"387aaa984818bfe1\",\"/knowledge-medium/src/data/childrenView.js\":\"8077ba8644df77e7\",\"/knowledge-medium/src/data/clientContext.js\":\"e56c4459a3690b61\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"a706cddc13c478cb\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"b4958c1c4052efda\",\"/knowledge-medium/src/data/derivedIds.js\":\"479d8a9fe2749444\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"26755ea86fd1c4cb\",\"/knowledge-medium/src/data/facetBridge.js\":\"2d597417c3502fe2\",\"/knowledge-medium/src/data/facets.js\":\"835e468371aa6684\",\"/knowledge-medium/src/data/globalState.js\":\"8219c1059e5eab1c\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"60cf818160ca062f\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"612e7409543f9303\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"324e22e67eed061c\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"24b09660052d2f8b\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"c680db6045c1fab5\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"1fd9ebbe6eac50fa\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"428cc07b46d31d05\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"fcc48d341290cf3b\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"94159e3bdaf953f6\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"eb5d9f05261d9fd7\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"9c26957b197f1d44\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"e4e774faa48b2357\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"f74f4b944f520798\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"7421d819fda35ae5\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"745a8e6ad8f624ef\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"3544256984aba9cc\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"e44cfd84a69c6337\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"e51db5c5bb8c20d8\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"0e788579fe1dd003\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"2f1c431c3c6631e0\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"6cbcd934f87daff5\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"e28b176597292a43\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"4115cb112e38b588\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"32e388644c738e13\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"9644d7c7b6ab0bb1\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"0575aaa2526d6166\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"86fd0614ea0c29a4\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"9d25769f4c743160\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"36ed2f66deb4de3c\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"cf7eb9b4082f7195\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"c85611db96a8116a\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"d48250799c1b993e\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"32d475702c16e817\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"4aeb562e43f59e9b\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"013fda4bd02688cf\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"21c0eb7749e5501d\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"1332b274a0570424\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"4f190012b6ca4582\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"e6c8657fd62c26fe\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"3ff10478fc528d99\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"18ea9531298521a3\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"cb39788608532ed7\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"18eeabd2bc9e1677\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"f5c7e5d2834e693b\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"c0f39d873ecb3b21\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"7c81772bb2ad558d\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"92f112a356ce633f\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"bbbb7e9523a10367\",\"/knowledge-medium/src/data/invalidation.js\":\"ef8c590d585bbed1\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"9c72045888cc544e\",\"/knowledge-medium/src/data/kernelPage.js\":\"2b2176462777b630\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"16a92289c7ee0fc5\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"f64678d377049d21\",\"/knowledge-medium/src/data/localDbStorage.js\":\"9257a78997bf29b1\",\"/knowledge-medium/src/data/localDbVfs.js\":\"e09cef1fd1030117\",\"/knowledge-medium/src/data/localSchema.js\":\"217e5f74e12c221c\",\"/knowledge-medium/src/data/maintenance.js\":\"38a3c5c944fd4af2\",\"/knowledge-medium/src/data/mergeProperties.js\":\"646d3ece654ae8fb\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"a14eb58568445694\",\"/knowledge-medium/src/data/migrationsPage.js\":\"bc8a2b8e20b8504d\",\"/knowledge-medium/src/data/mutators.js\":\"04ae88e797c8bb27\",\"/knowledge-medium/src/data/orderKey.js\":\"e00c0187cd14f88c\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"aca0e7b3acd8f65f\",\"/knowledge-medium/src/data/outlineSurface.js\":\"f684b54291041e72\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"3c8c00a7dceacc9e\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"98e5fee5c786f3a3\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"c442ddce6c7621b3\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"44c812dd9091d24f\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"813f70d57ec88cd7\",\"/knowledge-medium/src/data/properties.js\":\"6e21aff633715673\",\"/knowledge-medium/src/data/propertiesPage.js\":\"2b15d68bb29483d2\",\"/knowledge-medium/src/data/propertyChildren.js\":\"21a617b3607c8c31\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"82fc9dd7fff21c0d\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"2ce88abfa3e94e70\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"c574cdd139ecfcbc\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"19fe26fe3cb8b4ad\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"10d54b6abade866a\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"7f3733c594fd4273\",\"/knowledge-medium/src/data/propertySeeds.js\":\"de21b944765be6b2\",\"/knowledge-medium/src/data/recentsPage.js\":\"2ed0d066c09dd582\",\"/knowledge-medium/src/data/referenceBlock.js\":\"dd5678b89044742d\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"df5503c14b78613c\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"b87b2e14d96bb09e\",\"/knowledge-medium/src/data/repo.js\":\"d8932bce0cecd734\",\"/knowledge-medium/src/data/repoProvider.js\":\"06edff726fec1c6d\",\"/knowledge-medium/src/data/rowProperty.js\":\"d5b6ccde59c8ef19\",\"/knowledge-medium/src/data/searchFilter.js\":\"b5fc5fb36eb15aa8\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"cf3075909394a8bd\",\"/knowledge-medium/src/data/stateBlocks.js\":\"5648ce7fd8727872\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"b3ea90cb5b31457e\",\"/knowledge-medium/src/data/structuralInsert.js\":\"bc927648902ed461\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"70105d87bad6be4b\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"89562989678e89f2\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"1b0f87e8acada643\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"6c53d70e0e7636ed\",\"/knowledge-medium/src/data/targets.js\":\"bb12743457c07047\",\"/knowledge-medium/src/data/typeColors.js\":\"60a22e150f93a6b6\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"afd95dd5d5f286e8\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"4cdf2bfc50e8991a\",\"/knowledge-medium/src/data/typeExtraction.js\":\"376bf5b9e690a0e8\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"f745b2364e18d5ad\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"4b28f95bcbfd4cba\",\"/knowledge-medium/src/data/typeSeeds.js\":\"68311240c60e23c9\",\"/knowledge-medium/src/data/typeTagger.js\":\"196b7dc8d3b9811b\",\"/knowledge-medium/src/data/typedRecords.js\":\"09f7fc4be1cb94fb\",\"/knowledge-medium/src/data/typesPage.js\":\"5ef998370f7853de\",\"/knowledge-medium/src/data/userPrefs.js\":\"fda20bea70a241e9\",\"/knowledge-medium/src/data/userSchemasService.js\":\"0e4f4a28582837ec\",\"/knowledge-medium/src/data/userTypesService.js\":\"de5eb0c5721c63bd\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"2ae60e8eebd3371e\",\"/knowledge-medium/src/data/visibleChildren.js\":\"d9f9460c9bd03c0c\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"4db97646d63c91eb\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"065075f46341894a\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"73d1b0b1ef751e7c\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"20af159cf6ae5c1a\",\"/knowledge-medium/src/data/workspaces.js\":\"eb464f6be1646f07\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"320d8bcaad7db648\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"536ddd55db5d1662\",\"/knowledge-medium/src/editor/atTrigger.js\":\"0a5d535248ed4037\",\"/knowledge-medium/src/editor/autocomplete.js\":\"5007d4e60bba561d\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"eb087796c86954af\",\"/knowledge-medium/src/editor/contentFlush.js\":\"5c6357eeb57b6ff7\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"78e585630ce496c0\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"285f1f39180eb3bc\",\"/knowledge-medium/src/editor/insertImage.js\":\"0fbb6541b82d67b6\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"6c3c3128c6eb6d15\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"eeb00ed2a692819d\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"d1cd8b7d8a55de37\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"e4550cefa3e8700f\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"b8faad86a7ce862b\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"c8c2cb6c987bb7d1\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"0ba321ad7da8ef97\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"6992756355a8127d\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"b26565ff9108fe07\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"d8a5c84f9a5b8058\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"ac0115af617a8bff\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"3a019308bf4032f6\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"7da31dde6750de94\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"2dc627feb51efc1c\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"e4a6f9ea4e1792cc\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"1dc9a037fabf7341\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"fcf1e8ee852e12eb\",\"/knowledge-medium/src/extensions/core.js\":\"2ba542c65a65df98\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"1b5635c29b04c367\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"1bac22b2b3b4e891\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"d658290fc59dc471\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"d57da46d0a058ec1\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"d55bd4b5adc2e58d\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"7996a15ca603ef9c\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"4d7db7aaddfc9e36\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"05fb1686bc9bbdcc\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"f08ea849c7b7eda6\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"03c970a332ddba4b\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"4e9c08f7ea7f54ef\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"eed8b883dbae884c\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"3084f8616f9915fa\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"62f3f17af72bc555\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"bf7190c41b0626ac\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"c15ebd854923af63\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"4b53f6bfc2e324e2\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"706cd0ccdf0b450b\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"667e3743cf106695\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"0b87390fa0197af5\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"51e04279b0482d54\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"65bd95c4c55e3599\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"4a79ec05300c4d46\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"b88f227ea30535de\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"ef6556e17aa3008d\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"0d209989377a1478\",\"/knowledge-medium/src/facets/facet.js\":\"e5b6d5d57bf04b71\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"c49238ac1e6a05d3\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"08ff869d34a5f7e7\",\"/knowledge-medium/src/facets/togglable.js\":\"71d0a535fe598bce\",\"/knowledge-medium/src/facets/variantFacet.js\":\"f2b6923844db6c88\",\"/knowledge-medium/src/facets/verbFacet.js\":\"7f1229333b8d76be\",\"/knowledge-medium/src/hooks/block.js\":\"9afbc19c5715e156\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"a6590fba648ad9b3\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"57cbdf048e4a5ab3\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"c92c3126f49cf66e\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"bc2c40ae14c51d59\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"99f71bad2d196cbd\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"1c7b8a7c35e1bd99\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"257525c9c84b4a29\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"40a871ece5c0d60c\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"164083480cd85cfe\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"46cff6f8ca313602\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"337e4da6747108f5\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"8e0bbe035e621084\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"05ed65a8e0b6ff7d\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"e48f3c92579ee16a\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"2a142cc2ee88efe9\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"b0494f22a3f7d025\",\"/knowledge-medium/src/lib/utils.js\":\"7f56c75f04781a8d\",\"/knowledge-medium/src/main.js\":\"db6c7074f36b0e8a\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"fc70af55d6b68a44\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"5ff92d9af52240f3\",\"/knowledge-medium/src/markdown/context.js\":\"892fd6de5783ab9d\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"003494ba559226b7\",\"/knowledge-medium/src/markdown/extensions.js\":\"5d22d8a8c9d4785b\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"e14e5c7c8a9f3c1b\",\"/knowledge-medium/src/minimal-editor.js\":\"aa450a6e7c049e40\",\"/knowledge-medium/src/paste/armedCut.js\":\"f60759363f1cd349\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"36b56ebbc6b6bef5\",\"/knowledge-medium/src/paste/clipboard.js\":\"fbf0641d0ac43420\",\"/knowledge-medium/src/paste/decision.js\":\"4fdc516eacc9040e\",\"/knowledge-medium/src/paste/operations.js\":\"1e46afa8d933dc60\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"23e2980212765a7d\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"b8a846b343aa8d81\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"c5617cb9f0573c35\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"89cd13e6cdd4498f\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"e95a350447c63041\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"bb5230d542c7bb30\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"f896bd13f70bde1d\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"2e1c6cc6e8a7dc8e\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"f0a6c2a559e6b156\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"1cf8226dd0d9d56d\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"eab75b8ef30987cc\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"a5aec7128ed7209d\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"17d07ac7091209cd\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"0d6ae0f8cd8affe1\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"eb70877d953c711d\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"d95712505a28e35a\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"17e86e4d9a66de47\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"885db8d354048956\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"f1921bcdc568c45d\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"f35e2f9fa8fd6aa6\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"606b35393df24b1a\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"43a8431628401ffa\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"ce6d3d2541ca099f\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"8ec208db784cdfa5\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"096e9662dcbb48e3\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"1677b44e4115bb1d\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"7002faa046ffe610\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"77006d6bdde7002d\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"821fd23e295d4ef7\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"197fb8fa710c3dac\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"a75687506fdbf512\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"ea8472be09c8cc11\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"43d78398f5345287\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"f2b34016d389df9d\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"1a52612ec6546ad2\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"b238848c02a0a9fe\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"494a9c9482f603c1\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"b2d754ae133d3b03\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"98bbaf8a4632ac6b\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"35ea80905fcfd352\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"f06ad132fb117bca\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"14efffd59b363df1\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"7a53d3152c83e1ed\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"a90243d0c982c9ed\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"18edb60860f37751\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"3e87ec8c4aa1a789\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"102196d2fed408f2\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"633c4c93bd882abf\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"94b14efae844663d\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"9a6fedcd3845c2ab\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"9d279b8ebbe52c65\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"1f5b2fab39efd89d\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"50b1f5210bc734b0\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"4ce355b394efb2ef\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"f2a5628cb71170ee\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"7c5854baca98d89a\",\"/knowledge-medium/src/plugins/alias/index.js\":\"64cfdfe10d7b151b\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"b195e3d001fa1dcd\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"6e1c060114fcaad2\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"9a03333011492bd6\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"f04f6a4b6200fcad\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"e91cbd50e1777c85\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"e8460c8f03240c9e\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"b70fde2b0b40a6c2\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"0fd047c0d3aa6315\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"d3caaf47c8873635\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"49d9a2273e3abd28\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"631a135b6c24283d\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"3b02177da7fbb8e8\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"0be0e968bbb1c1a4\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"19dcdaad14c12561\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"fad4820a79bb7c2f\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"356f471fbeaf373c\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"e4d3f17b240832b0\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"fd8501e38bee7044\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"4e941046eab6c195\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"57024904ef5f2996\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"86452b160de21e4c\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"3846deb8cdc2e0e4\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"974fc559bbf1216c\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"da3238919e04fade\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"70bf20f70543154e\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"d1233cf6f11a81fc\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"aede7a3e8d6277c6\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"d8e8452137590125\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"4888ba092d58c559\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"da3644f289571ba0\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"eb361f1cbbaf27e3\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"de5b220ebe6381c2\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"ec7f7c7919d8026f\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"2f86bf3ca48d06ef\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"108e09db923eb5c0\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"7f40ec51ed16beee\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"98891322451bca22\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"2ba8af53ad540afc\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"0dd14a0490e9ea76\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"4c2fe833afd965a9\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"a47238d01551b833\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"e029b53df34c4f89\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"dd13ae5f0cc706be\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"ac62869223b53bc1\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"05070d9ba303598b\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"4a0792bb18985c19\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"568ab3e0723ed2e1\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"b0ac7dc1717ee53e\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"606f2e6742170f43\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"461b7bd97f86f40a\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"5b0a2b62aef122ed\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"905febb7622f8869\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"fd1107d2f2268cec\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"8db8264d61d8460a\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"84694136f15e64b1\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"6d653ac1efb30cd4\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"04c587226202fa3e\",\"/knowledge-medium/src/plugins/attachments/browserMedia.js\":\"665b0f2625096ba0\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"361790dbbd0036bf\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"a5cdfcbd73f495ec\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"7554baeff4811d05\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"5fd006ba58b1e52c\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"57215a1f3baf829f\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"dd9e79d24e74f991\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"ce66b00b3c4532af\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"c596ff8faef65e0b\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"d0e6f57b1dc6b48f\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"306102eb7eda7deb\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"ed5e4902122e46da\",\"/knowledge-medium/src/plugins/attachments/mediaLanes.js\":\"3c8784ffd9963903\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"ad04effd656d0a6d\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"60b4ffea3df97a41\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"9b72293c7b36aafe\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"53de5ba30ec881fd\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"a2a7bfeeacfad618\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"cae8987bbbc7e443\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"f35309bff9b7b6ea\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"4bc931857a95cd59\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"1650f3dbffffb2e1\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"7d1a522476121a80\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"78cb1042adefa7f7\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"f159303090f70873\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"812caed05c8a5536\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"09666456866967cc\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"76b159595e56292c\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"8fc6c7ba9bb43d46\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"c4317cfc4d73491f\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"c495d2246b3f20e2\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"e50c92e33dbce5c6\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"8a3b6a9b47474977\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"87de8f189621c605\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"756a64668e543e6d\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"43c98ceb36798826\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"d2ccc7e97802f031\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"df8058c7e9ade63a\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"a50abb2b0f6bc870\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"ca367072dffbba02\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"d161425e539f18c8\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"c5019929ced8cd04\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"5fad7800dd377ded\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"cb0811b86e95c73c\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"1882755a2d44be63\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"bb517737769a199a\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"c85808102e5b58cb\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"6cbee95c9965e063\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"ff6171198da97144\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"14f9cd66e0d50ee8\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"9bad98debc1014ea\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"758aa645c9fff960\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"a10680189604329d\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"2588618cc29686ee\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"d3d8d389398943f4\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"f10c0f43ec2b6553\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"244667fa147f9992\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"c98decf65bb5f372\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"3b1c3830e9e1aeca\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"94de5fe2a65372f9\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"71b0a6e7efc3a5e1\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"e90c5960b29ddd2e\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"f04a10871cb14348\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"a7c8c25be09f359c\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"023b8d430b9efb24\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"e27935823e7c8678\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"f164d604066a07a9\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"293e9c02ced49cec\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"be134e66196868e8\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"0953f7055e4d8fdd\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"49e3d08c6fa0e6af\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"680ed17580c70cae\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"50a4f2cd961c2fb4\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"e5f51aa3ffed6bda\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"ca7dbcaf280c55fb\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"313319b9036c4caa\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"99d5fd40fd09449d\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"13c04ea98a30ef0a\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"36a3202cf63ff488\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"c3d7a68b6b58bf69\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"9c4e421167ac4922\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"e3076429982e095d\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"d9eab70cf2bdf852\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"5a2fcb7002a79dd4\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"f4a8baa969abb6a6\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"7c56be424b1c36e6\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"5dfbd050bfae375c\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"a677e9d3800f0d00\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"c54b4e2aa91c1ab5\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"ac7a1fc9b2cdf2a6\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"2feb795c5abca5a3\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"70efac0d02b273dc\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"578cad456118664d\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"f60f3ecbcfc25728\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"24c310a8b302e11c\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"0fba64d42b29b6b4\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"59e244cc440417fe\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"66b7d9ae334f3033\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"947d1ad802cea063\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"65f6ca35e8f57350\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"279b0fe87da6999c\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"ad8baa54bf358749\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"095a91f20bb3aadc\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"964f216b87d1b7fc\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"9a03074943ca9ebb\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"0d9dc5b31b90a861\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"746e302a4db6570f\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"90fb5c6485eca46e\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"f2671d0766a0504a\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"086a6079bb5a6115\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"b532a920c31efb2c\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"166bb6a0746ebb23\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"2234d77d24027d8d\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"69710fd0a65a02b9\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"b86ed32f96e8122d\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"e5a018067bdba464\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"219408b5eb1b6c98\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"96f47aae5bbdf137\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"bb5d213b0ec12cc6\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"f0b420d7c122a51e\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"e00d02579d3e4621\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"36ef280e21c2fa04\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"c414ec31fec84aa3\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"8aaf0f2b571b0892\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"d4982c6337d488b1\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"0c0d00c5063906f4\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"a971eb9360c3a6b5\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"20cbaa5cf5ecfd20\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"a9bd89cc5111e7fc\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"5fa3bcde0b7077a6\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"785da7652dd62ae1\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"5f325ca9ddfd0a16\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"d6dd7cce0426190f\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"3250f5e8a5e11a89\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"34e8393ac081b9c8\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"fbc732761019d32f\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"dd0be97229cd33ad\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"262033cd0e9e6fcd\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"566e3377f202c51b\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"825a24956eeeca6e\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"09804a5ca44018e7\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"54a6d3174c9983de\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"61d2e8c45815507e\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"b310914e43495c2a\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"bd5289b2377cc697\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"b008e3c77b68fead\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"f2f0c362c2ee418b\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"8b1e214d8c67647e\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"4213350b27e6f134\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"151049c13669f2bd\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"2806ddae4a991735\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"5e55edd4d6727b37\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"5dd3635cb6566324\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"79b3efd06f214ce8\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"3a6e80a75a500ae0\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"f0614dca13d0a183\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"0536426cf94456ee\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"3e7ac6956ef29985\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"a2c93aa9b1afeff8\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"d54c7dbbff1ea8e8\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"bb0a0f97ca48dc98\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"33073983e2cc80fc\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"6c2cc0696d5d8932\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"7d6b04c85158a0aa\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"746cea0153f3a440\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"850027d9ef5cbdf1\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"4943ebd8e7277d3e\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"1b70fb85addf0efd\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"4167b4618747b48b\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"0535c0b7e77c7096\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"e999059763e70e1b\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"cbc1cce1e1848e40\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"56622e0d00b8251d\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"4e43d63d51c07693\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"6441fd5e849bc105\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"50619fb07e4ec1e0\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"954f75da026f8a9f\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"939df45d53f54a59\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"beb8e0ff03b7c7b8\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"1ae648af6485a49b\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"2ba4fc7310444f29\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"7e14c7930e931069\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"b7f20cb992136b79\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"52339f66e5bd2221\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"a1408670f3bbf9ec\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"e5ee6adb5348776f\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"b969c77afaac7941\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"3201b3f23b527c87\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"8716438931b7aa0a\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"e12bbb79399f334f\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"42989c2afbd03f62\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"36ec1e545c498bc2\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"720bfd7a4a0740f7\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"b420da6ad85e0962\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"b76ada5fdf4e5f3a\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"35ff63b5af29e8fa\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"9a313208953e046f\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"cda4ba02b41d1e2f\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"63525a29d56441e7\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"b7cd29c3c3616a5d\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"86ab821d3061f076\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"27d5156eecd61040\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"2e72eb3fb1b27fc9\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"d2dc7991350ee70d\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"ce3ddf496270097f\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"d1d6485b295a4f95\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"1fbf42d4d9bf9b79\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"422805ad45f5862e\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"08649a2b70e0d21e\",\"/knowledge-medium/src/plugins/geo/index.js\":\"5f65a41d1f6144cc\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"54cc4c363ad18449\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"3880e0a9fdbeca51\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"c1abbf30ad62adb0\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"a0c0330a47aaeefc\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"ef699aa83e3f71ad\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"5b12146fe4a1355f\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"a255a360c290fa06\",\"/knowledge-medium/src/plugins/geo/query.js\":\"61c8787151c1fba9\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"e55bfbb3d145edec\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"2ace33a3c2598aa8\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"235466da030d6c32\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"fd6df3f566f7d728\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"1113a50870b10bfe\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"d4d707c0c9d1562e\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"283ccaeafc3ab3cd\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"f1d82a34ad5c2aea\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"04cb57115c912dfc\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"1d52d0eddf35e8c6\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"904e288e8dc9b322\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"4714e0c09647d6bc\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"7b544d4ee2a30b13\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"4159020b9e62dedd\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"9b56cd7caf17f2a3\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"caf4a85b1f800222\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"4d147b8edf27a0b0\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"990b50abf28c5138\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"8898a91e0bbfdd11\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"48f5ece9a25fa397\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"09a16af6d46879fb\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"c4e5d44cd337dfb0\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"b763b5eec38184bf\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"660e7db97b85f701\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"c8246db755046da8\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"2e0f5d75bd7f5e1f\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"f55c032c893a41a5\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"2feba4ed1ea83d33\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"30cc6419d1850e3b\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"6143e44fb2755b80\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"a89bd2f5fca21f90\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"6807689688345d55\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"bc9581582fbd9c87\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"141c158201fe55fb\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"9e05a776d8740977\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"f6cdc994cb1faab1\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"ad734a55b45d4a8c\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"ca56848bf7c3206d\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"0f9cd637a36f2653\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"5e1453bc801fbec2\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"d8efe4a26291acf9\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"9adc57d72c3a4fe5\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"95826808e7b85ac2\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"3fea6444e51c3b82\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"67ac574211935860\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"8ad174d1cb9f3099\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"5ff8972752782e53\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"e9d66b2a0b1bd490\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"1f459ec4ba76bbf3\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"cd66619a7fc70fc0\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"3601e35ec107d916\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"321992f341b6d734\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"6298c15af2c28eb1\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"94b63c65a94069dc\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"4c823ac511e75b43\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"0598189145a57f38\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"5f603c36577247a8\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"4398ccf3361b61f4\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"0f39269776086a0f\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"f98dc9171ad44915\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"2b8b375fd8a04bf3\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"0347be6f423d7755\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"7f4149db57a8147e\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"52e7747167e9cf64\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"e6b2888f1348b47e\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"e766bfde72703563\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"6587b98b2bd279ea\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"e3af61c03e961d84\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"6cc44d3c86ac87b2\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"052f2ef4ec2e45e7\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"4fb36bf3699d190a\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"e5b548721c3217f3\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"a749d3bad01d1851\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"8c60779f3e566963\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"1aaefb6707bee83b\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"25df8723d7620d85\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"9eba9550782efb48\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"f4ca0534b8c83481\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"fd740d5e461e8e9b\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"4a67f08475382cc4\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"4f6ed1e7154fed55\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"beacacc04d837470\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"db11094fb4f4080c\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"899a2adbd2c6e49f\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"44ecfcf9a3e35a2e\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"6763ea3b6c753151\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"e2d5f85ae5691c8c\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"78fafb495af78732\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"ce96007d96aec0cc\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"8b6f0745958f25fb\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"e1f01f5a9723ea8d\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"be35ffcea871f9ce\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"2fb47e7f54f0565a\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"4c29017ba235e832\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"0a5d71d8c91e6883\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"1f0258049defa0ec\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"d0fbd95dc9731236\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"1363c0507f1cb278\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"7fd0f1a8cee3cc24\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"d8b6a0fa0e4e8a50\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"91be626a2b9328de\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"d71d165bcf075644\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"d5d5bf47521246b1\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"13a79451e97aa7b1\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"e8b5ae627333d47e\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"e00090f34a20e0eb\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"31b5efc94aaa1506\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"8fcab661066ebbd6\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"85ae3ccdc3407a89\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"b5d29f710f4face0\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"15004c6028d82400\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"d2d5ebf6e4a5f368\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"e3b8f6e0d280b538\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"05ae6a8b6b320c34\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"c2b30ac398069263\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"c77f051d300cfcc1\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"99f1594c81468da4\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"b5ef74871617bec4\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"aa297a66292ba833\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"6e811b4427384ea8\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"f92634ba6345616c\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"df1507d40af73eac\",\"/knowledge-medium/src/plugins/recents/index.js\":\"d8b2ff63f01da8ac\",\"/knowledge-medium/src/plugins/recents/target.js\":\"f7a57270fabb489f\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"2f1ce4e2b2660381\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"33e8c3754ae97338\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"78c7abcf8127da59\",\"/knowledge-medium/src/plugins/references/index.js\":\"67c0b68709a37a53\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"5b429a57e8d7737e\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"df97c46649a43616\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"8d660c432c32dcbd\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"cbb70807f6972aac\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"2ea6d751a806dc37\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"77290ff8baa445aa\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"03500569efdd5bf5\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"b4ce9c2e219d7a4c\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"5821abe1c7ac621d\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"646414ecd5987329\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"5f9947b311a58f92\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"63a45787cfbcab66\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"bb73aa88b26c8b87\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"d5c0a4d0c75a7fcf\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"d65c7a360e4ccd63\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"812b6d6882248f55\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"14c7a19cc06d5606\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"ffb2f6377fb3a8cb\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"56b5c100787f231f\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"dd99636c9b1ac472\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"3c6c367f020e66ab\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"c3e0879818d77be9\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"b7dbb5b2a29476fd\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"a78f36eefdd09565\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"1ad2c93768fdc562\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"6e89c83f14556130\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"c750bcf581e7a147\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"c75b443922d669ff\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"d61ed2027bbcd4e4\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"ef5b38a543e8f9e1\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"37bb208b5fed3a80\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"242ded6bea08d1a9\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"ba65efe345146fd1\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"7d571d720469685a\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"6f5b9f7358346411\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"b98c0a6ca760608c\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"c897b69fe2c6d494\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"cda674ba440aca79\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"0df286d74e4b18c8\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"e562cae4cf6b2d69\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"1cf6478429a3b74d\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"1d5a5232d3e59281\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"7b774bbfd318377e\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"935c0bc822d3f79a\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"df6495f70085fb36\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"21b3c455cfea0881\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"f0b0f1b769d778a9\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"49887e11acb72cc2\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"2f58414e8a2e2009\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"3666b3ab083ac485\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"4af7c016c3d1311c\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"8af5d8ec57833975\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"a89c202c6e86ecbf\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"e1b5068f5f995dee\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"6eca344ec574e065\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"fbe8749d76a45286\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"fdcfe4c54050b76f\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"6be6d2c460af62e5\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"8bf2f5efbda374b4\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"2c48543da97d7aaf\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"229bd2717ccd18f0\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"0d59be9652c51c40\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"b311547bef2a6262\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"e18260d05fad365c\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"4b3f95b6cd71a3e2\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"5da40307996d487e\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"a9f54788e25b781d\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"8aba7ef60a52c0e1\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"2bad775156b6ae84\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"2e8a57d68f2cf97a\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"22c16707c0da51b6\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"7f03369f5a64493b\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"3047fa0a39a889a1\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"4b37eda6b1a5f32a\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"152d4ada17e1462d\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"e12e0aba4ade4072\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"c60613292969479d\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"591febf72e714106\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"a903e8e9eed0d970\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"5f3b47fc39af9cea\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"d690168ad5c815d6\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"c14052ca14791b14\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"c5209655778ad072\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"7d57bdeedc04c7ae\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"73b97858253bae1f\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"394039ae585e1335\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"98e048fda4904931\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"c0885ea4e1fe1c5c\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"97dd6a7c0070a69f\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"0d1ce33d166ed399\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"9f05451d5439771b\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"2b7025d2b9b9b9aa\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"b56b5587ba5b503a\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"59de879bcfa6bba2\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"f8b48b773637290c\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"2ab86bc4a5453129\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"38421cbfbede72d2\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"030620241b4ea048\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"64ebb85db7b338c0\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"bd9aeaea39d44535\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"85fcc2e9d281b5bb\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"34abf8ab18166374\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"1c4a243b8e93ab5a\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"8b67381f06da659e\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"e03134f0f3146b04\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"e7560b9f9db7fd4a\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"0f478ed823220f88\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"512220a314f3d7e6\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"3346fff0fb7f7eb5\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"fa8705dd3eeb82bd\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"a678a3945817a35e\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"b377d3a2edf032c0\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"d3c4fc6cd472563b\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"18f880e2d347ed5e\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"de9bb00b1eddf81c\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"2345c63e1c1d112a\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"506f38e20cc310e4\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"be97c7efd6ddfc62\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"955f69b1b43c74b5\",\"/knowledge-medium/src/plugins/tables/childrenViews.js\":\"40f338d5701dbcf6\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"2e7ff18b37da513c\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"b6ca5069ee14e9ed\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"fabc81aa9dec4546\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"853dfcc0a7a76d90\",\"/knowledge-medium/src/plugins/tables/index.js\":\"3fa9b5a6aa0cfcda\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"a71a96daf4f7a5e7\",\"/knowledge-medium/src/plugins/tables/model.js\":\"7dc5bc7d9d8e784b\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"3596f67c8bb73544\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"b2b84864ac51b55c\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"1b81f9950511cd3c\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"b63da3527687368f\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"0114ed8f71c3f2db\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"f50ffda9cff36f46\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"4312f57ac62fb95b\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"7d05747a926a1356\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"0f76fa31eb83ba06\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"55ae7afbc39bae82\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"b83024fdc363cc35\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"4d067295dff35d70\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"a647da77b164f002\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"41066d990c3da124\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"f9a63d24413f7ae0\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"bb1a4e249c83511c\",\"/knowledge-medium/src/plugins/todo/index.js\":\"aff6d76674795610\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"cfb09686a6b5b659\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"7b5bc7bbd7c6d6fc\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"4ba8e5cf01791cfe\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"5a4964a9098f894a\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"45b7be8ef3580b26\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"655103f01a1c3d1c\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"08742621419679d1\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"7b130782265f004e\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"2d135b72b9f47f86\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"bf38b068cda4fac4\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"a296306494432c47\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"33e901925eb2510d\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"6d19a97e7387593d\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"78a88d3fe89e4349\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"44d030f55d211476\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"30abb82f5ee88dee\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"a2ed2a5a9cfd60b3\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"a190fcf75dd7025a\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"dcb71ec5b8311f11\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"783274beff9a7769\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"1a3014f01863c4f2\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"e2ef2a8a8dbc896e\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"51185e8c3dec3028\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"1c2c3a660a10868f\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"05da05b1864a35a1\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"354284f09d43a9a9\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"a565b484d098cff4\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"bdb3e3eca4549239\",\"/knowledge-medium/src/registerServiceWorker.js\":\"7e1700286e711612\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"d3ad9bc1365c522b\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"205e8d8785d0eb3d\",\"/knowledge-medium/src/services/authStorage.js\":\"f0ebd0d9d859d2ff\",\"/knowledge-medium/src/services/powersync.js\":\"8a515fe85a6f9c21\",\"/knowledge-medium/src/services/supabase.js\":\"0aaec465e82f42ae\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"570ef429658ab51d\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"42e14d92d6f84d84\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"3795491e9dba0d5e\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"8cc6ba4bd472eb59\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"8050cd04ba0298e1\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"b288667a4e58e3d5\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"7b5fb777683db4bd\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"0d25e77a2b1e96f3\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"5d3e5c7e90ff8348\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"bc3cc6c4e407d1ef\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"eb3006d9b3f97efa\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"93cdfd82039a06fc\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"f5205b35ccf4e049\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"aeb4a46e1d0f031c\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"029060e08c938210\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"ad63b8b275de1373\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"8f1c2bb2ff0eeba2\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"a45301cef957df72\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"251b751a40114eca\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"48e986a525970495\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"895d6daa0a6936d8\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"847079dfd3810f68\",\"/knowledge-medium/src/shortcuts/types.js\":\"24e86bcbfd9c9298\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"63b701de94de6017\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"6e3855279684caab\",\"/knowledge-medium/src/shortcuts/utils.js\":\"cf0da97e1567c56b\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"3f078ceb49e45377\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"9098fa3e474be807\",\"/knowledge-medium/src/sync/byteTransform.js\":\"dda6fa11172fad88\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"c452ecdd5b08d43b\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"d1af2ab2d36c1e8c\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"0bcfc133bc4c2cc1\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"5e33638a484a420a\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"97981adcceb467a7\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"4bfbcda652b301dd\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"988c825be95ec7c2\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"cd4d0c42968a72ad\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"e767e1cfba9a71ca\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"1f51acc7e1ae6a12\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"c248cf021ea24354\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"57aca10008f88bee\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"778b989404acff39\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"d3e43c68c56e7757\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"9cd71e0ec29134f1\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"c317ba3d30180766\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"6efd22e30abde914\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"b1b98f03a97247f2\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"d10eff7883f71123\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"ce60508d6ba09e2c\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"5ba445f2c2c9a677\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"8ffde445ceac1211\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"c464a344cf4650af\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"f9a48e14e3c820bf\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"9e5aa528e5a85cb6\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"06de6760164f550e\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"db2dd41c2b29a715\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"1d54d384e63b4af7\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"6fe52a696bf4dedf\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"dd6a1ca2e139591d\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"1c2cfce3ec8235f2\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"468dfdc825ddc560\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"5a3dd7bdc04bf21b\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"bffbf3596b20486d\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"3140ed72b8976c34\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"3fa04e920033a104\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"03e07da9aed2c62e\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"7fbdaf27bc133578\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"092203948e94f2b0\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"2332c4133026f9aa\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"faba00724cd249eb\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"8aa0ff27b4a7abe0\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"e8118345c9e16bd4\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"10941f83c130239b\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"5af72f6b965907d8\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"b2633bd5da28867a\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"eaabdd8d8f5c96af\",\"/knowledge-medium/src/sync/transform.js\":\"e53de35d12d6491d\",\"/knowledge-medium/src/themeBootDefaults.js\":\"0cbfb621df6d39ac\",\"/knowledge-medium/src/types.js\":\"20ef6afcd6e4016d\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"94f8c4499e1ff5d6\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"e053dafbacdeadcf\",\"/knowledge-medium/src/utils/array.js\":\"c8ecd6dd678fc16c\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"dc3998635fea9839\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"bc9a4c0da75a05e1\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"61414bac24a0f188\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"96d39d2788563cfc\",\"/knowledge-medium/src/utils/callbackSet.js\":\"5c74411e5b206a78\",\"/knowledge-medium/src/utils/clientId.js\":\"167dcb35ed21e215\",\"/knowledge-medium/src/utils/codemirror.js\":\"79b691cc9e478bcd\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"2c389931c5d220de\",\"/knowledge-medium/src/utils/copy.js\":\"3cb006b6b9acfbdc\",\"/knowledge-medium/src/utils/dailyPage.js\":\"18a05ecd0aaff2cf\",\"/knowledge-medium/src/utils/dbForensics.js\":\"15cd41f4217ed8b1\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"b2425418015a3b8c\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"b1c964b46fd1e935\",\"/knowledge-medium/src/utils/dialogs.js\":\"56deb008b86eb58e\",\"/knowledge-medium/src/utils/dom.js\":\"5ace8c61caa1806e\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"32efba669010991c\",\"/knowledge-medium/src/utils/drawnWalk.js\":\"9c922d7f4f26f22c\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"6d50e0451558f99b\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"82e64b2e75af3541\",\"/knowledge-medium/src/utils/flipSlide.js\":\"ff016bb19dfeb691\",\"/knowledge-medium/src/utils/fnv1a.js\":\"351959c3054c5d37\",\"/knowledge-medium/src/utils/formatBytes.js\":\"1de0049176060ff6\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"b98a7c8c86cab3ad\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"d887b15935781826\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"57b5ead976a58f58\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"9b894a7ac02b8cda\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"3468eccb406d6b86\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"eedd93a3ba469d71\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"58e91c609f9756f7\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"28cd9fcbfb9aebc0\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"2b08cab6befc6e31\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"6d08e30e4c95e67e\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"9da36798fee5b8df\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"846bba9d63b596ae\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"10e8457d777d92da\",\"/knowledge-medium/src/utils/markdownParser.js\":\"3fe46eff04c2172a\",\"/knowledge-medium/src/utils/memoize.js\":\"8b41d71e58116b89\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"873df3ba08be6093\",\"/knowledge-medium/src/utils/nameList.js\":\"6f9cf9736b2466da\",\"/knowledge-medium/src/utils/navigation.js\":\"b1b84f9abf2da1d9\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"5635bc99fa09e313\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"8366d1f297ca5876\",\"/knowledge-medium/src/utils/panelClearance.js\":\"5018fb047c9b8763\",\"/knowledge-medium/src/utils/panelHistory.js\":\"eff80110ecef8a52\",\"/knowledge-medium/src/utils/panelLanes.js\":\"1fe3eda599a9f953\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"1718517011da3367\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"a642340fb8d3149d\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"e518eb6164ad9565\",\"/knowledge-medium/src/utils/platform.js\":\"8fa0fb6c70581ada\",\"/knowledge-medium/src/utils/pluralize.js\":\"f2046903be420f82\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"2f7aa6afcf48e324\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"537407ddcfd0b8a5\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"8bb9685c9d5db30c\",\"/knowledge-medium/src/utils/react.js\":\"e41cf1a5185e2391\",\"/knowledge-medium/src/utils/relativeDate.js\":\"92733718637ab8e4\",\"/knowledge-medium/src/utils/relativeTime.js\":\"d414eaf4469c311d\",\"/knowledge-medium/src/utils/renderScope.js\":\"bba62ae5c966cd91\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"8d559f566ca6b1f0\",\"/knowledge-medium/src/utils/routing.js\":\"05c485e02b1fd47a\",\"/knowledge-medium/src/utils/safeMode.js\":\"9246c7e2bc46f924\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"31a6e415ccae3a40\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"3c8ad44616d9c60b\",\"/knowledge-medium/src/utils/selection.js\":\"3a3db89feec3cbf6\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"6d29074f8e194672\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"a83f9c2011eae3ae\",\"/knowledge-medium/src/utils/state.js\":\"2ac8892fa320754e\",\"/knowledge-medium/src/utils/string.js\":\"e68f14fcb0936879\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"edce2f2d7dc95ed2\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"46e18004dc1fed32\",\"/knowledge-medium/src/utils/toast.js\":\"94481982f9a49438\",\"/knowledge-medium/src/utils/toggleStore.js\":\"f47fef8ec9d8ef45\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"181224c44608be59\",\"/knowledge-medium/src/utils/userActivity.js\":\"c58302103b620267\",\"/knowledge-medium/src/utils/viewTransition.js\":\"6b8fc3b0f8d2210e\",\"/knowledge-medium/src/utils/viewport.js\":\"c06d76da7a5c12bc\",\"/knowledge-medium/src/utils/webLock.js\":\"f4d6944ac4ec2ef4\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"7b543e4dd85a97c8\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"335bdc8744378300\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"301785f67e7481bc\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"8a11032b30c1e0d2\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"d0a35202b6627c9a\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"0aec8d1ea2bc5b59\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"420703066ec72898\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"805f27068131c746\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"df820e033a341300\",\"/knowledge-medium/src/vendor/react-dom.js\":\"71bf41428f6f402b\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"aa713808d52bfce9\",\"/knowledge-medium/src/vendor/react.js\":\"fd814f07ff8ca921\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
