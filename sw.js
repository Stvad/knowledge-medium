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
		buildId: "d8264a2218d1-91a1cf84",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"e2b34ebf48f8dde2\",\"/knowledge-medium/index.html\":\"e2b34ebf48f8dde2\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"6e3bd4a005b4bc56\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-CsM0Ag7D.js\":\"7721066d6e92b1f8\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"57c9ec4dbd33b778\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-BtAj5Vm2.js\":\"58b4504d337b2477\",\"/knowledge-medium/chunks/FacadeVFS-D34Gy7wz.js\":\"a2ddc94d160066fb\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-B402UIXD.js\":\"056519b0b886ddd5\",\"/knowledge-medium/chunks/MemoryVFS-CpyRIF6R.js\":\"dea10d28cd86ae78\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-Do3EkyYQ.js\":\"5f627f9149a1dbb7\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-DiIvfSR5.js\":\"5891b3e459bfb6a6\",\"/knowledge-medium/chunks/Preview-1Xjdpc2l.js\":\"d128670f40755603\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-BFXxOYc_.js\":\"7e7e578494fb10d9\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-Cj5hulZ_.js\":\"249049c74050efba\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react--kb1Fbct.js\":\"59e96f10c34ec664\",\"/knowledge-medium/chunks/react-BuQk5w-d.js\":\"54ec516ac86dc01b\",\"/knowledge-medium/chunks/react-CFkgm02x.js\":\"f353bd1330845fde\",\"/knowledge-medium/chunks/react-D2xQH6tk.js\":\"c82e622d059b2313\",\"/knowledge-medium/chunks/react-DHIcNpHa.js\":\"5a08caef68f89322\",\"/knowledge-medium/chunks/react-DgXJj8ch.js\":\"a9986d742fc3d1f4\",\"/knowledge-medium/chunks/react-DhySeime.js\":\"f3419926f5edbce3\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-BTNgaVvc.js\":\"a2428ac1ff41176f\",\"/knowledge-medium/chunks/react-dom-server.browser.production-DoH_UN13.js\":\"73c390dafcdf80a7\",\"/knowledge-medium/chunks/react-dom-server.edge.production-DAp-UOyP.js\":\"6fb2daba16f1702d\",\"/knowledge-medium/chunks/react-fERdW9fd.js\":\"ba1329540b245bae\",\"/knowledge-medium/chunks/server.browser-CROXMfGD.js\":\"1160d2671d717ed2\",\"/knowledge-medium/chunks/textarea-DEtFNIHY.js\":\"7436edfa1e0d73ec\",\"/knowledge-medium/chunks/ui-BUvxAMNL.js\":\"929b57cbf46f65c0\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"d939c4575e1c3411\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"df2982d39e517eca\",\"/knowledge-medium/src/appUpdate.js\":\"6dab547f75cd9445\",\"/knowledge-medium/src/appVersion.js\":\"743bd405f7387d10\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"957477e518094c5b\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"aa93948267d63303\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"fe64cf5efb86d7a3\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"da5f6f9f79b10857\",\"/knowledge-medium/src/components/BlockComponent.js\":\"8ae43b8ff8dd9602\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"e1a628720e734efb\",\"/knowledge-medium/src/components/BlockEditor.js\":\"4018080524d4af90\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"d71352eafe9b3725\",\"/knowledge-medium/src/components/BlockProperties.js\":\"265a43ef5aeb7f01\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"b985f611302dc19b\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"cd86d641b4803211\",\"/knowledge-medium/src/components/DividerHandle.js\":\"92ee6b5e9156b05e\",\"/knowledge-medium/src/components/DraftEditor.js\":\"a725a37c90371722\",\"/knowledge-medium/src/components/GutterPill.js\":\"3f8c42fa4dbeeeaf\",\"/knowledge-medium/src/components/Header.js\":\"8fbe8d2a00f49a89\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"c48e7b85b045eba5\",\"/knowledge-medium/src/components/Login.js\":\"7676b8d9ca72cfc6\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"3b91fb0a0cddc2b8\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"9fc6182df9738fcd\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"910fb4b283141032\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"4f065913f9939168\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"3adf9ea843f1eb00\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"ad32a4820372e5ee\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"f25ce217b9b367d1\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"ff2c6c040b1a4415\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"5a3bff0ffb758a42\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"e1018a211edd1f59\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"5f3c4ff804f4e572\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"aed265fb461b7ac1\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"5b981426b1a498c4\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"cf5063213459f578\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"37b41e43b4642b7c\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"df83cd2337e0e736\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"6086679918363b3c\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"994cc4886085dba5\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"fe956f1f3e7e9335\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"4e9c83f35f59437b\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"cabbf2290f836821\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"31d67e37f6b69f8f\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"2747f77bafce8c65\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"1e2d93abcd20f158\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"49cdbe609765b483\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"6fe36934704b6ecf\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"a4c8e5e4ec287861\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"7cc0593a717e4ae2\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"8d2ebe87f7c7ad2a\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"0b4bae56dbb797fd\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"09d2a2d3432bc535\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"d6226d44ab6bc332\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"20f82eacf43c0b7e\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"a68a18285203f368\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"f8cef397c739dfea\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"73e3fd27c2947f9b\",\"/knowledge-medium/src/components/renderer/BlockReadText.js\":\"3f049924bd48a45f\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"98a66e9698071c64\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"fa3545de89e444dc\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"3aa3f7c1ea738a63\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"13289d6c2c2e1bbe\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"34a2bddeed24f55f\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"de7fcabb324d6beb\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"ca50e89b509e2977\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"b4cdaf04b10cad6b\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"ea1dfce958454524\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"f79e9534152ad7eb\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"e3f1464087ba583f\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"0424a02d1b4eb5d9\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"b1033893bde9ff19\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"886bb5470b4dd7b2\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"8b3ad4a4ae025caf\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"f7cc447c8e31ee7f\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"d71de42f657f2e57\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"5bf96a85e8edf306\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"a3ff2a633a766429\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"367195b53278ee5b\",\"/knowledge-medium/src/components/ui/button.js\":\"02b89ac37f25dd40\",\"/knowledge-medium/src/components/ui/card.js\":\"61c4f098ecf995d4\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"aeb86dc3a1542cd8\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"54299d18994f0436\",\"/knowledge-medium/src/components/ui/command.js\":\"3b5f6e007911717b\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"b08a60c8738c4a38\",\"/knowledge-medium/src/components/ui/dialog.js\":\"d66ab8200d5eb2c3\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"87abff571c18e46e\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"d88ba396a024364f\",\"/knowledge-medium/src/components/ui/index.js\":\"50082a608b487229\",\"/knowledge-medium/src/components/ui/input.js\":\"a20c90df3ba14ce9\",\"/knowledge-medium/src/components/ui/kbd.js\":\"7daca415d9fa4518\",\"/knowledge-medium/src/components/ui/label.js\":\"16b55ab3fd6e3448\",\"/knowledge-medium/src/components/ui/textarea.js\":\"84dfc09a392031fb\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"40efde3be82141ee\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"ba1fe2565b45fb11\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"11a97c929cd51b7b\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"26d625105369bf11\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"fa4649fb5442e334\",\"/knowledge-medium/src/components/util/error.js\":\"2db315aad5a5ad89\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"612e281661b6caeb\",\"/knowledge-medium/src/components/util/suspense.js\":\"64b79dc522a0c577\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"c5869b33d2ad03cd\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"6126d0d906c919e1\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"d1f34b83144f8c16\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"4585db17f3e9a539\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"0a274e8dcb772cdb\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"5d5e27ee0a26b6e0\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"783ad8182d206367\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"cdab444679b7cca8\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"c9761390eb058fc0\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"ce08faf3d4eda7e8\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"8edfd809e31adf76\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"33b9a33b9de6b8ea\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"e30f08084bbcdcf8\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"b1ba5f726c53e4d6\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"fc531c4dd714f001\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"19c2d7d46eee7973\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"34715a912fa7c3e1\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"f69e72aecb5fb884\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"17b032c654504290\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"b98f8310abb9df31\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"2a2b9e62117afcfc\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"cfbeafc983c65c35\",\"/knowledge-medium/src/context/block.js\":\"04b06758ccaed41f\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"58a7ebfc9de1e78b\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"24dc690191815ce4\",\"/knowledge-medium/src/context/repo.js\":\"5e263b5114fa66d4\",\"/knowledge-medium/src/data/aliasClaim.js\":\"de65b4c86bfa4784\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"14ff780c1f2b9291\",\"/knowledge-medium/src/data/api/blockData.js\":\"8ec9ddf284da600c\",\"/knowledge-medium/src/data/api/blockType.js\":\"bcf67ac536785d89\",\"/knowledge-medium/src/data/api/changeScope.js\":\"d513f745ed7f374e\",\"/knowledge-medium/src/data/api/codecs.js\":\"ebd3e4dc9395de6a\",\"/knowledge-medium/src/data/api/derivedData.js\":\"5d6b3fadee027da6\",\"/knowledge-medium/src/data/api/errors.js\":\"45e61a39917225a8\",\"/knowledge-medium/src/data/api/events.js\":\"2df61c189977e38a\",\"/knowledge-medium/src/data/api/handle.js\":\"cd4183d9fdbda15b\",\"/knowledge-medium/src/data/api/index.js\":\"4d36e72aa55dbb23\",\"/knowledge-medium/src/data/api/mutator.js\":\"4498233213793130\",\"/knowledge-medium/src/data/api/processor.js\":\"112616333f1821e6\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"489dd607372503f3\",\"/knowledge-medium/src/data/api/query.js\":\"8b7a40bb9cdead26\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"27237a922ca0e963\",\"/knowledge-medium/src/data/api/schema.js\":\"cd4183d9fdbda15b\",\"/knowledge-medium/src/data/api/tx.js\":\"cd4183d9fdbda15b\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"312e85a43e5038a2\",\"/knowledge-medium/src/data/api/user.js\":\"a0e6dccef175695a\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"ca76343b7e593732\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"8d45a58b1038757d\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"be3fb8b0cde918a4\",\"/knowledge-medium/src/data/block.js\":\"232e31ed99846342\",\"/knowledge-medium/src/data/blockCache.js\":\"e93119459a04be9b\",\"/knowledge-medium/src/data/blockId.js\":\"aeb32a57ee3cffa8\",\"/knowledge-medium/src/data/blockLiveness.js\":\"437e820dc7110310\",\"/knowledge-medium/src/data/blockMerge.js\":\"aeae00b17b12535c\",\"/knowledge-medium/src/data/blockSchema.js\":\"b017b6bee5344766\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"22a3590bb58fa085\",\"/knowledge-medium/src/data/blockTypes.js\":\"cfcdcfa70412b9e0\",\"/knowledge-medium/src/data/childrenView.js\":\"80db52aef49c944d\",\"/knowledge-medium/src/data/clientContext.js\":\"c10133571b2d20be\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"9f00aec547c50ac7\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"9bd819635e864eee\",\"/knowledge-medium/src/data/derivedIds.js\":\"ef0ef5118e653bc7\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"ac2926bd3b055e7c\",\"/knowledge-medium/src/data/facetBridge.js\":\"37cc167ef27d218e\",\"/knowledge-medium/src/data/facets.js\":\"30cf353b0c3e70e9\",\"/knowledge-medium/src/data/globalState.js\":\"8422c3754899992a\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"87bd01c0342831c5\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"ef38d5a76b50dc10\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"3b4ea821701f9f1d\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"2b3b004019c22168\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"63490c72e3778fb0\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"0f7dade263d4e4fa\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"6903f42ac0c8bc0e\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"a5f0c45d245c662f\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"a126efdb505b3ba0\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"7c103df6fb8f07c9\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"7b51b44bf3375326\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"238832648b3053e7\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"87a04592b8523f92\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"3960f3fdd4e4906c\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"575ac31c7d119d09\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"701a2c1a8a221757\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"65c763e8a8e94566\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"ee6026dc572c7af9\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"323c53d3866ca01e\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"367fc7fc87412533\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"39f0c0bc7085e46c\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"965b4bb409bab979\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"aee0f23bdb85f447\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"c9ad51a4ce9bbc9b\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"7e2a06178a2b07c5\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"97a5fbe85980cc06\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"7ac7e2c3d397f811\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"094bf039b765eaf9\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"0eb6a528c7a2511b\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"6d6c717c6538f80e\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"714596d4f6108315\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"5e63e030ee9998b2\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"2a2796b9262d523a\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"befd1a74b8f55afd\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"271ff6269fab0f63\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"9040b55525591a0b\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"6393bd1299629878\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"11bf6993cbca2786\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"e3b602de329127cc\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"7378b0b819cf8937\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"28a990229c218bb2\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"e362a2d8f99fa673\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"9058809209ece6b3\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"ab3edea30690e82d\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"a7425b92dc4d2062\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"ecd588ee276bb601\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"d1892a62cb747675\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"6a11fc09d3cc3c43\",\"/knowledge-medium/src/data/invalidation.js\":\"9679091435c0f1de\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"afb147ef54356b90\",\"/knowledge-medium/src/data/kernelPage.js\":\"379ad1e3ca1095af\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"f8fb2b6f256e3520\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"3676b41c47675129\",\"/knowledge-medium/src/data/localDbStorage.js\":\"9b6ef65a624ea95e\",\"/knowledge-medium/src/data/localDbVfs.js\":\"48d7944ae4f84fca\",\"/knowledge-medium/src/data/localSchema.js\":\"d25b53fa3ef69b27\",\"/knowledge-medium/src/data/maintenance.js\":\"0411c42a21d1e01a\",\"/knowledge-medium/src/data/mergeProperties.js\":\"df1031d220f4011f\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"453b767dbea51c2f\",\"/knowledge-medium/src/data/migrationsPage.js\":\"6fe9ef57801baeeb\",\"/knowledge-medium/src/data/mutators.js\":\"447ac64da84cbad9\",\"/knowledge-medium/src/data/orderKey.js\":\"bcafbaac08dd61fc\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"72871828a32fc3fc\",\"/knowledge-medium/src/data/outlineSurface.js\":\"6c8b67cad43a0b4f\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"8a4952015613ef11\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"7bec6d0af9bc9177\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"420e21eca13b88af\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"0d883627ecc5cc3c\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"cad70d4333c68d61\",\"/knowledge-medium/src/data/properties.js\":\"ec96ca32d5630be9\",\"/knowledge-medium/src/data/propertiesPage.js\":\"a135dcd7d1a0c48f\",\"/knowledge-medium/src/data/propertyChildren.js\":\"6ef88c56ccc80fbd\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"efc82d292b58dfd9\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"980a8010a81657f7\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"9eaaf57ddc1622f4\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"3c5dbef93b201a92\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"805c369d5df84044\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"64db33f3b6dd5f0b\",\"/knowledge-medium/src/data/propertySeeds.js\":\"2c0f224917f10e54\",\"/knowledge-medium/src/data/recentsPage.js\":\"c3fdd0eb073539c7\",\"/knowledge-medium/src/data/refTargetComparableProperty.js\":\"56516449c97a0604\",\"/knowledge-medium/src/data/referenceBlock.js\":\"42141442f8f61715\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"3d8792229f010ac3\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"ef4dd13a669ccdbd\",\"/knowledge-medium/src/data/repo.js\":\"44dc4c3a0a351bc0\",\"/knowledge-medium/src/data/repoProvider.js\":\"4cdb8f1fb358928c\",\"/knowledge-medium/src/data/rowProperty.js\":\"93f702ab9ecaf076\",\"/knowledge-medium/src/data/searchFilter.js\":\"8e689f7a8ce4784a\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"5576a19c863ad4dd\",\"/knowledge-medium/src/data/stateBlocks.js\":\"4a8c779a8c0a987d\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"c42a23238dc2e4a0\",\"/knowledge-medium/src/data/structuralInsert.js\":\"39e792d31973374a\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"60ca60f0a98e044a\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"5eb5486e5114b7f7\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"dc8577b28e709452\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"5024b5ffee3131c6\",\"/knowledge-medium/src/data/targets.js\":\"0eb5f5186e444f79\",\"/knowledge-medium/src/data/typeColors.js\":\"a2c009d8cb3c9f73\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"541ca0ada1a49492\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"6a8c87f50a7158a5\",\"/knowledge-medium/src/data/typeExtraction.js\":\"e95969c6b1068d4e\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"1b4547a42f146c48\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"fa11054f46d221f6\",\"/knowledge-medium/src/data/typeSeeds.js\":\"1260b20d40af8880\",\"/knowledge-medium/src/data/typeTagger.js\":\"6a07dfe97b98de6d\",\"/knowledge-medium/src/data/typedRecords.js\":\"c43c88bf9a80bd46\",\"/knowledge-medium/src/data/typesPage.js\":\"8c4795af272bf441\",\"/knowledge-medium/src/data/userPrefs.js\":\"79726d7836794b26\",\"/knowledge-medium/src/data/userSchemasService.js\":\"52a784b991af690e\",\"/knowledge-medium/src/data/userTypesService.js\":\"2f72c55792d968ea\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"916c5a5d7e5319cc\",\"/knowledge-medium/src/data/visibleChildren.js\":\"3696711ce32073ef\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"9958cb32c553b9da\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"98688c9968ec9bd7\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"24fa232470212cf1\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"7d60c6d766bda608\",\"/knowledge-medium/src/data/workspaces.js\":\"29531dec10184da1\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"594f1f75f0727f59\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"c75a30111356e90e\",\"/knowledge-medium/src/editor/atTrigger.js\":\"18dcd3992aff9213\",\"/knowledge-medium/src/editor/autocomplete.js\":\"2c67305002e1f5dd\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"789e6cf031043bf1\",\"/knowledge-medium/src/editor/contentFlush.js\":\"d02023d2e6419d5d\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"f4038e96a577bf65\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"b74576a4098f6dd5\",\"/knowledge-medium/src/editor/insertImage.js\":\"dd879497575abecf\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"cc5973d646f305b9\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"0b623ca1ff0ec8ad\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"bebd14fff60bab4e\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"1b0a29930a176201\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"da280447b1b56219\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"1a3199598359111d\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"075b3202f07f9a81\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"507dcda00a1d7f04\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"a4c1d5fdb0111f0a\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"c2977ce4067f59a1\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"7d982672325a6cdd\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"cb8516f8d1fa6fb7\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"f51af44b23d5cce8\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"64664214bc0a7b97\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"20d3147c387fe3f2\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"f0ac71a632e22e9f\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"d1e9fac10a8cd67c\",\"/knowledge-medium/src/extensions/core.js\":\"70eb429c3bee339f\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"cfb7bb839c93bbee\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"2992b590cd69770a\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"79ac97b4de67fd71\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"016759917a39785c\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"1c2642d5c620ca1c\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"72e6f00c28524539\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"a460b16823d552ce\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"f2016fdd4f015b56\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"6cffbf5767b8d401\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"26f00f295a809360\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"4b4f1e57e1a9cb2b\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"adee4ab1f806cc21\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"5ad0d8b937da41db\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"e36a51e865ede4e7\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"9ea265f6f0f63cbe\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"29d468be31a1e7df\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"d6325b23faf4d6ec\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"d7bdc2e141f78ed9\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"7d25cd74706611db\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"e4954d3d5266bf86\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"78b5f0b1149b9850\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"09f85263b23fc8f6\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"0c2c56130e36949d\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"bc86d8159a96b302\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"6ce6231103aa5a76\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"21a2204a0301ac52\",\"/knowledge-medium/src/facets/facet.js\":\"04f2594b35357b3a\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"f50d3d565040528a\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"90ea0d4662268157\",\"/knowledge-medium/src/facets/togglable.js\":\"2a024a2e4222c7e9\",\"/knowledge-medium/src/facets/variantFacet.js\":\"410dcd13f59aa47c\",\"/knowledge-medium/src/facets/verbFacet.js\":\"496d616de77da870\",\"/knowledge-medium/src/hooks/block.js\":\"0143095d166b8083\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"2fa4e0fe642793df\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"08ff045b24071e79\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"4b22af1859ee826c\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"7743259249e7407d\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"225c110db2729432\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"6e891e36039088c7\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"1d5796106a8ca3d7\",\"/knowledge-medium/src/hooks/useFacetValue.js\":\"3f2a4e2f9cf92eb4\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"08f54c9d1683f3df\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"78556d99ea07427a\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"80edd5d65fd5817a\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"e52bbaf261ddeb95\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"76643c19f3c25b23\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"aaec28c08763b9e1\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"e6f0a48ad8599e4c\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"4343811b8e4e971a\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"98268ffc9afe7141\",\"/knowledge-medium/src/lib/utils.js\":\"f6424ef19626402b\",\"/knowledge-medium/src/main.js\":\"423a075e1b9e6bbc\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"61cb9a2da9aef176\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"c1619d0fdddcf3dc\",\"/knowledge-medium/src/markdown/context.js\":\"bdf420bceb130f16\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"f7e3b1ca2fc88e07\",\"/knowledge-medium/src/markdown/extensions.js\":\"dcca4b6c63982edc\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"08c7971772194fad\",\"/knowledge-medium/src/minimal-editor.js\":\"acf50d3e9db125b1\",\"/knowledge-medium/src/paste/armedCut.js\":\"dad8ac879e0c5d82\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"b8afd4b2697a944a\",\"/knowledge-medium/src/paste/clipboard.js\":\"a8819cd90b67946c\",\"/knowledge-medium/src/paste/decision.js\":\"04df75083db469ce\",\"/knowledge-medium/src/paste/operations.js\":\"50f20b048d1cff4c\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"27cb3e323ebeb8c1\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"461e92632f886d0a\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"cbae3c495544f4ee\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"e93ae71ee5862cbb\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"602661815ddf9dd8\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"31cb6e6f6c31bdf9\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"b3d7c7f1ea049c02\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"c490de597179c136\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"62374fea7b96df8e\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"df768d0d1dba1d75\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"9dab9fdc906fc7d6\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"4502cd9640210bb5\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"0e65c74c16b6d190\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"d8bfd240c95ecda3\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"390fda6f2c6ca281\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"404147e8d8372ed2\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"b2758616ff23ee5a\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"7e3543409f0bb535\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"71239d5fdb130310\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"ea78165a66bbef75\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"23d9eddc035fd9a6\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"ce21a94b168c8a7c\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"80ef98d115d09ed4\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"07c87bdd1cb50098\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"ff9404c03be3148b\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"a486011a3c6e4b18\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"e329c0b6a5628e6c\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"6403a9b1d1eee8f2\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"2f4734f340849dae\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"386f4f1761bb8e42\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"dbb0928b5d2c19aa\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"f88c3c82413f5433\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"9c9575915840c786\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"ccddf8cc545df7b2\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"bab63d23420ab0eb\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"56be5813f4aee5c1\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"4223403ad0d782cb\",\"/knowledge-medium/src/plugins/agent-runtime/dayPropertyInputs.js\":\"081c9f6676926dcd\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"30f297d25f6efda2\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"d0b8611978edf1bb\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"c4c629f8f86ae823\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"7647d7d3e8a64623\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"8ddc76883b89d03b\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"7d48e308c5ff1fc6\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"795728aa9619abf8\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"0b8320cdf3255b61\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"cf260b2a794abcce\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"f3625af8adf3d103\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"14a8ae2199b59005\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"78379d3f595c843b\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"a20c740c76617eba\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"ef46159551c1f4fe\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"f8648e756323aabf\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"b93539a85f0e5386\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"bceb1d5572875447\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"d3102a407f20e9b1\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"17a74bc73bd7d372\",\"/knowledge-medium/src/plugins/alias/index.js\":\"b716ccb9c161c2bc\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"cd3f87fa4f872fb7\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"3b24b4a734fc2ac2\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"ef48e0585f001c27\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"9f9971c17cfe8c8d\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"2072040d4924d468\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"e02eb393d8a61295\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"b74efd63fc5d8235\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"a5ecbe6c2f4f173c\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"f265aa303b9e251c\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"2b082940ee740eed\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"0d63a1918610bb94\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"e8815f555d6e1351\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"d2fc9a14955e00ef\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"27c7c59f7afd38f2\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"ea27f2bf036376a8\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"83c69d3fd15af011\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"4ed519579b171e54\",\"/knowledge-medium/src/plugins/annotations/marginAnchorLinks.js\":\"3b3bbdab4f0fff36\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"26744553043a2f7a\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"614580d81aa6b350\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"3e038a99ace5848d\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"c748e9366283739d\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"25933f4b2345c8e3\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"b265abe8b0b0b0f1\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"a6debab3b16f46ef\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"3d0ed2a1c03818e0\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"745b16a5e924a1d3\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"753bc08c774c8985\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"272472425ef18925\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"fb7178d7a38cd73f\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"b529c9bfc7c2c71c\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"0f403cc92e7e5b04\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"c682c7b908cfe082\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"3ba2c375b16a9f76\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"9d3a5e0810b89013\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"37c499fb2fa46d96\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"7c6a5c03d6c1370b\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"293d11a7a4cd2332\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"b99212025222d213\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"7e40944e6f044106\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"8b2da4754a6a82b6\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"151492071ae6eecf\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"2c5bcbc4e9af7efe\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"cc8276ee5f152cc1\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"f1eae0d3c92c0bc8\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"1209d27f46c4b18f\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"121bacd771207279\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"61de540c65b21b9e\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"c06df7a0e5dc1497\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"512ab9f1b3fb3643\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"5b9876968ee24c87\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"89ec7646b9bed480\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"6305ab2cf679a25f\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"ce9bc148ee3a6bf4\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"3723ea882e9f27c2\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"d0d5e93d6a333be4\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"3d838ffccb367251\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"c2aff87938cae336\",\"/knowledge-medium/src/plugins/attachments/browserMedia.js\":\"e7ad7025e3944ddd\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"772efc4113df8499\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"2cefcc6845c9ab8c\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"e524f1885b34e639\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"58129f3d0d693cdc\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"2c46969d6df80c46\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"1dc87d8ec694f0cd\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"f7d18663a7ce2628\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"0a06abf9b3d4bbe7\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"c787a6b440c4c312\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"4d0b346d44965cfc\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"e577e1bd3cd1b481\",\"/knowledge-medium/src/plugins/attachments/mediaLanes.js\":\"cd03bfc7728cfa79\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"3d376c4c4b6e39ad\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"84156dd672b7ebd0\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"d335501bfbf2c3fd\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"b2c7b80f340a9174\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"2167b23b9b717db1\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"4ae2ccbd3a94504c\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"435dbaadd23384ef\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"4e283557569227b1\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"bb895f067899100a\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"269228e8c738ea89\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"f04fc3bffdbd9367\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"862e5bd5770c6204\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"bd2452aaedea279a\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"79e3fe99eed4d925\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"9966d73fe30b6025\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"ff2953b449c2e7c2\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"abc7d1b313af7ddf\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"c6d7a621e6612666\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"55bc067eb8d8906b\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"740a63cc94edc9e8\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"bdb7570409e09024\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"1805433f9b65767f\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"572e57ad2581e704\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"20602539537a6a05\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"6380ce097f0f46fe\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"0482514265ea9858\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"3a31ab9a9053e347\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"4d5c83723b20a568\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"8059cd9d54d6575b\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"55ad1cafb286583b\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"d4c59c21cc694d3f\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"9e32c7b61eba734c\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"98e0bef6333c976f\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"c3423d5798132c10\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"e0890855ecba29bc\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"71afaa3ff2ac8f1c\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"dba4f26581f71c2c\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"ed3dae29a6448509\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"d5ea1e295ea138db\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"844055e7aba7d7db\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"31d10f2e7e713e14\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"6344fbf4b4dcd631\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"447fe5b873c7d41f\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"d25077acc5767191\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"fa3260fe69e297e4\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"e881e6fefb301603\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"7bbfb135a83f69c9\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"999788c37393ab90\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"6577613bcd8c9bd3\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"7f8d6a9403147141\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"60155d49df82597d\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"56d9436a8f29764d\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"e9f6c655345c5f47\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"244e94ef3fb950a1\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"5d6fee9688de101f\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"e11fc2e68645a983\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"5da70427ac0e7eb9\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"869cb4dc78faebf6\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"642931146cd0557d\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"59e2e9c85a3a719e\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"f1b881972af22531\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"ae8ff112b0bdac3a\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"5855fef697408b05\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"155db833873a4bf8\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"74c8a3dae81b779c\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"8f425ccd6914240c\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"aa4fbe94bacdd566\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"35412fa3e5b2c4fb\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"2c6970f4628c4ffe\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"6469e320c655cf1d\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"65b15f5e8cf04a9b\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"2c8374de92a3f49e\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"357d0ed63b1576ad\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"0b41331eb2b1b12e\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"2e3b2c5afaf0a3fc\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"ad246870cb92609c\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"1eb50cfc939029eb\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"29d4c3e6341374b5\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"f7001870bd9f7464\",\"/knowledge-medium/src/plugins/character-counter/subtree.js\":\"9c4cd1bd78e99034\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"acc45f82a56eaceb\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"f330d98ffeac6771\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"681487f01d73943a\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"6f1cc4264f78971f\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"5b6042ce04cf65b8\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"6d1ffcc16df137c5\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"bd8ef74814e325df\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"f4e30666829b3874\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"02b43e15c87a962f\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"92da9a74dbccc00e\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"9b757ebbe182a0f5\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"ac3508ed19444b05\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"84f72262bd6e595b\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"74a65040a659b9ac\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"d3cbd5c7e583d716\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"7f9015f36956ccf3\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"979558a8801ff3d0\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"06874d250238ffc4\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"12508ec2f734a7ea\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"ef0257ea83a1d6e0\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"32549fba43e874ee\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"304f8b7eb6aa9687\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"94d2c29650c82cb2\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"843a168a6d77ab2a\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"185d16e4b79f7f02\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"31bc4a355eac8b1b\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"66096fd4c1bd75df\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"61226eb70e5eb392\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"394f5db14bcaca49\",\"/knowledge-medium/src/plugins/daily-notes/DayPropertyEditor.js\":\"2312567bde811e52\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"75098a1de83d26c7\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"1d5e9d212db106e7\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"d060206379a39642\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"0f525409584cc844\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"734f1e7346db6115\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"fb6057a3db9d419b\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"74a7cbd4a943daaa\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"7815ea7be6de68c9\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"080e66b87bd64c0a\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"210d8689ed159799\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"8e2e65881298c7f6\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"65bfe4ae9f34cdc3\",\"/knowledge-medium/src/plugins/daily-notes/dayProperty.js\":\"ced0e531760d7e4c\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"6b2889ad8064023c\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"b2b92481c20d8e88\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"4f26488cc3d8ae88\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"86c9579eb505504a\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"6b0bcf02b89194aa\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"2f64b2a87642a0f7\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"b6d9ca44eb21a1dd\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"2b605252cc6445db\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"7c7d6515eb6b5415\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"876e2d2fa71b7631\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"be01c879e2307a9d\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"a025f7644dcc594e\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"10e2f64fad3a5d5b\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"8f872a85358dcc13\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"1a52cc70d36cd91c\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"0663e4386c00c608\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"7a6db8856a239f38\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"15fec96a1bcc5b2d\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"604b2b90e1aeb600\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"5936a6b99d0fa9f4\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"8b02afc792cf486f\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"a207a13076a280a0\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"478ac20c83816867\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"527676a50f683b0f\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"8a7823c112112021\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"4ac47b11fa4ff43a\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"63e1791bd5c2f7a2\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"ca11cc594a030af9\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"ed9f06a6fc9ad623\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"7186c4b0d5db238f\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"ddb151ac7171893c\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"93926cbd2d0fd8c0\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"9776c7c4c0d35067\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"80a15f3cc50bb480\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"f00f1c84779abf0c\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"6622723f6f8b80cb\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"fd29ebfee68dc9cd\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"560c796f1b7c0244\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"7929305a325c7931\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"3a6ae6eb9621a0a9\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"f02900e16eadfd98\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"a0cdf61afe0c151f\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"359aedd95be4443c\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"afb655c716693cff\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"635b3a994cef817d\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"dfc8bd6085cf6b8d\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"b5e0ba0b44f86f52\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"063b61ba0adc7eec\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"b3b4a05618a1e656\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"111e4fdb33645f05\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"d76484be19a63fcf\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"40001f66160c0999\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"61cb89e638f52d18\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"efc0997f619d4366\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"0c025ede5e1d7394\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"ffa46b49e52a24d7\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"ce34348b13e5682a\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"412c13e8d1046d53\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"dda00a1b2401f6e2\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"81c61ec5cd253f6a\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"6fb1a4f294bf914b\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"826b28f6bfc0d13f\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"ac1e24cea5f0e9a8\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"cbdc76804d9ca4a4\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"d3155ce60cc59392\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"89c1fd1112fdf1e6\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"b17c793eb16a9b48\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"dcae92f8d352b8be\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"15dd48a9d2173643\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"dd358e069cf5939e\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"4bfe31ca91b8f5d8\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"583c615f9297421b\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"099c3b2c572d2b8b\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"7a58ffb2448db47e\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"1a38fe5521c8a216\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"756892e648ace8e9\",\"/knowledge-medium/src/plugins/geo/index.js\":\"e2d924bc062380a9\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"44ea590256347e6d\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"179a2e9c790f888a\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"8285c9edc7e78fda\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"efbb0db8108484fe\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"3f47956657b65e5d\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"b223f15a15c9e833\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"b34aed2097e7a95b\",\"/knowledge-medium/src/plugins/geo/query.js\":\"8ad59dda1b6e8ef9\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"61daa5b3611f2f3a\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"5fc2b0cea3fc87b0\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"ae84de3d5b3bfbde\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"8d851ddc351721f1\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"1360169901de1791\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"cc40aa6ebcb66252\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"e51826d6f8c3eb6a\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"9125ddd07bec9a24\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"41457ad735881f72\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"3c674bbc823e02d5\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"7aa82a37356d0b0f\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"48a58b37a9d59093\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"bff38f1991d7bf3d\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"bf44f2bb14d9b265\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"8a48097ca6a3d29a\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"83bc8673fd023fba\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"f51efdf4c75c111b\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"afeb4fe0c09b1970\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"b81e1085f8e2dd2d\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"17b5b59db3a88beb\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"df649aa657ca6a22\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"9a3bbb1f591a86e6\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"aeecf96b1a1f40ef\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"abd9eadd3fd887e9\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"98aed821b91fa2f5\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"f688166a8a5885d2\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"c9ff278d659d7c31\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"d0b3beee7df35322\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"be010fb8a66b51e1\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"286d179c1c819a22\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"cadd33741758b72c\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"a9e995e9a2397313\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"6ca16a75b4475794\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"63f4f76209272f8b\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"aeb1ee8f63fd60f2\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"651652029231724d\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"d978ac85b9de9e00\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"bcc586c9e8b8f71e\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"64caa450fdf01ff7\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"6fe339d7437a8dc8\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"e8f7415fd0f3dadc\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"e7752d54dd8a7179\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"6cd64cc38a1211fe\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"41a01b1adec49dee\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"95cd527ed60c78f4\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"7502d67807a2f2cf\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"8a908df8e0ce2213\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"b45eabea9772bdd3\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"96e4da117b01a276\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"a5aa8d194244878c\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"eae2e0b5f0751ae9\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"e9ab7e8683b193a5\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"11b94201463e62ee\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"84dd821e11cbb445\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"9ef5a1372aab5bff\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"aed7de4928cccecc\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"405a1ab5e2fe5a70\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"567d96184d63cb17\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"6115913aff1eebb7\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"3a6e750aafc75bf3\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"ddd03b1d4dacaffb\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"e14f495867682cf6\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"fc66cb40cd93cecb\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"97eaab5f20c7c244\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"b8587a7bc7952fa8\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"2a870fec33349ea8\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"dcfff375156ac29f\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"d511c51ee0f86b69\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"f572f634f352bdba\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"a26c395376d6e826\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"4c9b2e07525907d6\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"83131e788e6398d0\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"c226b6fa8062ab7e\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"4390e4d9463e5ef5\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"9c80313b79df8fc0\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"62fa6a21e9eff897\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"f3c6f325a68fd844\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"b7fb53f6688a062e\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"445869cd95263125\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"6dce2abd4f7923bc\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"d8c34968691db3d3\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"f525ca6665488de8\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"8cf33435b6b1ba8d\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"320c5f2ce4abf97a\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"7264b982ffc9d3cb\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"858d0c25e284fece\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"73728c7a690a2810\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"a917d437637ae361\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"3fa5c0e0b8cdff8b\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"40c9fed464bf7040\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"b4c6e6a7e7fea8de\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"15d5483a26dac9b1\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"620c9e777d45f755\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"76cb0af4e109436b\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"8116870bb37fd0d2\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"e75b745c0168be31\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"d3c73293996d7cb6\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"8dfe30281102ee1f\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"c7881474227fe7d1\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"63099781c6aeda6e\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"476f983b41c4bc24\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"76bd41645dee4f43\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"49bbae095a154111\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"344e5a960be48a4f\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"471b0946249d8ea5\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"1baef42b4fbad388\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"d482af45c9885878\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"8fdeb9f8e0c97fec\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"719bef329c46672c\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"bede06bb1abc9bf0\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"7d8c0a1a5c1127b9\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"06bc8fecc97cbc90\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"0fbb7d28009a848a\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"b21a78127100a102\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"46c476601f6d1a2b\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"ef7a4f36c3721998\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"b28ccd3e21e561aa\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"21c3e77f88caf8fa\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"e7cd028681e5dafa\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"a815d244f445399a\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"3a8bb835297da1b3\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"04135826e52c17bf\",\"/knowledge-medium/src/plugins/recents/index.js\":\"0836630d6ad1b92e\",\"/knowledge-medium/src/plugins/recents/target.js\":\"6d9fe5c1a6151ab8\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"7d6641ab7f8c3592\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"ad6c34afde0439af\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"106633af785cc657\",\"/knowledge-medium/src/plugins/references/index.js\":\"7aa03663aaad9c2a\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"c45065af45e82426\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"c177f72da6a6c1e3\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"acefac9fd89942f0\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"838461e7b2466fe2\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"7e04e666a8f09dbe\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"0dffb13e3034f9d0\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"fcc4b21a10f41543\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"cf3bd0ab5127a747\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"0a98c152f507c3ce\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"32145cb10a24be32\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"0e822f7743a0b36d\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"fd0ed254eea921a7\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"40d206da41aeef66\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"793936f05cc7c0b7\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"06f0bd12f51e885f\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"60d47ef6576e3d2f\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"e952e908fb372686\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"4d9cad58a7ba580b\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"d6feafc60ea3e119\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"566e0f261289b01c\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"8f2d2b30231542d6\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"18875ca2cf00f807\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"516f345b88d77ffd\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"6350295ac5fef339\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"0e0eff084df0d5f0\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"aa1e822617530bb2\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"cea18767a61b679f\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"a27ebf3f0c2c7327\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"83686350ffbe5905\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"391782862b47ed9d\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"5c7574b0fb85be3e\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"6a1dfd1ca4ef7366\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"5b80cf4cf540a47b\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"926bc3af9c1fe1ac\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"78fc2e952af91dcb\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"56ad4513eff269d1\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"4f17593bf81c4708\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"853607eee43be4b2\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"1dc14f84fb1c0afe\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"6641046dcfe147ea\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"669cdc8a608a47a7\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"14d6bfa9701c4723\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"37d2f453c7862b58\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"16e9b50f87ac9427\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"918c0af179b1517a\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"df27677b936f24ec\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"100c49d48ba20b56\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"e81f5b6a792df619\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"9b0a41105c0a43a7\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"96b3485e31f312c7\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"226411b8177bcade\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"b750ecbadd26569a\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"6edf6cbc70bf4bc3\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"68013d78d8543529\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"accd3e01f12ec642\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"8f4a2b76a22278f3\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"e27c33851b9daa0a\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"bebeb9b107ad9028\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"6b50b5b6fabb9843\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"231fd318a9663710\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"01c3f0aaa79f26b6\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"1431e49b335289ec\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"426c9cbc69ba5d2d\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"888d392c80ec01a7\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"a13ae3caa9eb69a7\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"f8f0da921f80cf21\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"4516112f6590c9e7\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"e71540f5a8fab2dc\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"c67637aca36cb0e8\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"a011dae1636c3b0f\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"6c4ffb3d94126595\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"31f9c378d3863f0b\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"bf5bf0eeff9f02fa\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"956b250c334fbafe\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"981e555e0ebcd407\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"c540ced1df555de5\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"26c312eafb256e36\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"0e169eb8bfa5bee9\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"2da59901ed7d5e3e\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"4690398d4c5b15d8\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"84092e8885f6b9f0\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"ef6d01c9cd044c29\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"3cf5a52d99a8a3d1\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"d3524b31be0190c1\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"3d5111010bcde187\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"26a043bd0b677b61\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"691cb136568593be\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"12016cd9be8c0527\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"8b8d933ba812837c\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"a753b45959ce2d48\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"a7fc99c9b18981d4\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"fe54672c08acd1e8\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"dbb422d948a43098\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"cf9c3454d7b02413\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"a4523d7567d2c3b1\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"626c37eaa969520a\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"d4925b0fd027779a\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"130db667e2dd48ce\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"b61addcaacbfb6bf\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"2f5781e99a923c86\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"3eba887077e0f7e1\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"6ad1bc14e55660ce\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"51fb208ae0c38816\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"3c7905bc265b74ef\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"712738f5dc5812fc\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"b3a2fd1089ebf61c\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"9e5cc38ebff9743f\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"11ca9b7246709ec2\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"1a3a7d524ea504ca\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"408eabebe5a1c360\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"2c8c3a3729d0def9\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"c4437921d2434920\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"3964a90844ac21d5\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"4757e2099049c2c5\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"dc727ec9d09d09cd\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"959d282bff8f4867\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"1862d058b4e3fd05\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"40d21aa4f280102e\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"b730561d8e5a4c3c\",\"/knowledge-medium/src/plugins/tables/childrenViews.js\":\"5b7041b33ef0c087\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"5ed5a7035f994314\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"1c3e09e1f603a9e0\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"d4fcfe1e4688c6f2\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"1e695b16ed5a672c\",\"/knowledge-medium/src/plugins/tables/index.js\":\"4290ea10ec839468\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"755c31239b50bba0\",\"/knowledge-medium/src/plugins/tables/model.js\":\"fc30f6206f466113\",\"/knowledge-medium/src/plugins/tables/query/QueryText.js\":\"5cf14564513862f8\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"16cb1bd7337d45e9\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"fe2e21451bf958ed\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"3582d886cdd94012\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"8659a0c5ecc58b59\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"79abb426361f74fd\",\"/knowledge-medium/src/plugins/tables/query/registrations.js\":\"e9ed0477f51dc89d\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"09d29c3c23169019\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"f285c85e28c3464b\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"2edffa41113fdbc8\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"3be4b71c060b00bd\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"6a962784b010883b\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"aadcb5540c90e10e\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"252e10c8937e7fd3\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"15d03e7338b35cdc\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"0e53865cd2450a9c\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"38a504573f86eb24\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"260030ba54db84f4\",\"/knowledge-medium/src/plugins/todo/index.js\":\"9ac74b80ebb37b34\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"0294bb06b775780e\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"c98320a00090219d\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"115edf7ef6d957ff\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"936dfa4a43006c0b\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"47e381d3b656a020\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"2729a0987c7f7ca4\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"4e0a73a7a19b89d5\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"4014caea71724e38\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"2e111f6e6ab98b2f\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"8aa55c8fc99e9506\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"894cc07ee61017d3\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"7ce5c63ac485bd51\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"2d1c5c1920101746\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"48eb528872c1f3cd\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"3da633bef2bef795\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"bb802fb6d37321e2\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"59d0bc6ccd74ffc3\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"7f01e55e6d13fb84\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"83a22b83ce472d7b\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"ebffa54cfacc808a\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"50f7d327f7a488bf\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"c87d850ea5e7ba01\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"0be7566b3f709379\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"2add148a9b342372\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"440a1cf69ee29b15\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"eed00728ee12d92a\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"b3e887dc0973bd64\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"6e0c4f46935f9004\",\"/knowledge-medium/src/registerServiceWorker.js\":\"f9e496549a274c95\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"340f4095aa7536b3\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"1ac6fc504c5968ef\",\"/knowledge-medium/src/services/authStorage.js\":\"5d9b8248e7c5ba48\",\"/knowledge-medium/src/services/powersync.js\":\"7c7b077df7ba9cab\",\"/knowledge-medium/src/services/supabase.js\":\"ede640c2467a57ae\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"1efe2d1f1f03ff38\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"7dfa8b50e855abbf\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"269c58ab1ee0343e\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"c440c365c524addb\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"b65ea91f00aa0bd4\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"36fae82aa6fef1f9\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"cd2ea8eca75421c3\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"e576aa12eae2c0e9\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"5ec62b60789e9ae4\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"8c5d6af684c3d30d\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"dca1d3885b1f511c\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"34ccfcd7bf0cd328\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"04b1c0bb5ac08ad0\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"4f082a55409b3998\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"3a21f3cc9be8325f\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"6f4ee68ee6e354bf\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"dc3bd7897464e212\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"a649dd53de0fc0b4\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"28aa48cf6243df74\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"41238648fe59d141\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"dfdef384e9c8a79a\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"a5420f99f60d9f20\",\"/knowledge-medium/src/shortcuts/types.js\":\"aaabc3282d28d335\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"d0858b39b43e6f39\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"96899742de3d3bfd\",\"/knowledge-medium/src/shortcuts/utils.js\":\"4ef199faaeddfa65\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"a6363c4c2a83a7a0\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"66db57049ae55ac1\",\"/knowledge-medium/src/sync/byteTransform.js\":\"ffd2108dfd000242\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"467f9b4de01c0664\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"30d5c0b672e32373\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"d37ebf4b9cf45302\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"f587484d122346f6\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"c244caafa0c1af37\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"3bc5bfe89adf4286\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"04890554b31b7457\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"eedf9e05bba6e5fb\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"f6dd356787d136b3\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"887bd424c352a427\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"d37cf2311c133087\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"4eef5815f14fcb8d\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"a057432315023fa0\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"ef6a30743c747cae\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"c9e2ffa0b5c513cb\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"1e49ef946b2f28a5\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"bf6c2594b85f311b\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"31a5ec8a1a971a92\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"a0f1d0ae5483bc8e\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"f7fb7672bb634265\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"dcc1ecd294dc3c56\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"cc339f557b7898a3\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"5a42ec432eaca512\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"455423761b48cd83\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"a534f7399ad68d53\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"8273881a518f18cc\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"71199ee145e4d6fd\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"2526566fd85ab5d1\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"de9c591e2413ed29\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"8d2ebc44342f84f6\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"2160be9cf23840f9\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"742315a0ce972188\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"51093a4bb0591dde\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"56710f162b227da0\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"6305512aa76108e2\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"2d3ef32cc2a62588\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"060e2190b9f0285c\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"fe2cbf951ee0ad01\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"57439b188dfa3d1c\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"f3c8bf32670303ed\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"ef9cd3618ce064b3\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"ef14eee6e37a8a56\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"ad92436c3c7d2a54\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"790aa0dbeab7651a\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"cad795e8c01b303a\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"a1eaf86be54bdbd3\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"7d46391b11789df7\",\"/knowledge-medium/src/sync/transform.js\":\"1face9bf91718ea0\",\"/knowledge-medium/src/themeBootDefaults.js\":\"9306f0ce33086d2c\",\"/knowledge-medium/src/types.js\":\"690ce970f59a8fff\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"6cacf45ce03c2f66\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"071d95f4da5c9194\",\"/knowledge-medium/src/utils/array.js\":\"c68beb2eef95c6ab\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"0da56ca5a8579d14\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"2e03bc828a413ff0\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"957055ca00a45058\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"3e952adef421d39a\",\"/knowledge-medium/src/utils/callbackSet.js\":\"b06aa448dc68fa4c\",\"/knowledge-medium/src/utils/clientId.js\":\"23b66cb34dde4604\",\"/knowledge-medium/src/utils/codemirror.js\":\"f60610f4bf9b0430\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"ead93f008040c090\",\"/knowledge-medium/src/utils/copy.js\":\"c3a849685fa3b18b\",\"/knowledge-medium/src/utils/dailyPage.js\":\"62c83d0c6a402a59\",\"/knowledge-medium/src/utils/dbForensics.js\":\"d25eb138b7827317\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"00081201080215b0\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"f5ed2d1dbb7f081e\",\"/knowledge-medium/src/utils/dialogs.js\":\"c05fb236db00e974\",\"/knowledge-medium/src/utils/dom.js\":\"43082d738a0f084d\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"f1d94e4a9ae17101\",\"/knowledge-medium/src/utils/drawnWalk.js\":\"9e69a8002c29df13\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"ca5e8c258260d83b\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"434bda159ec2f697\",\"/knowledge-medium/src/utils/flipSlide.js\":\"f6b239a793c1109b\",\"/knowledge-medium/src/utils/fnv1a.js\":\"2e11d5eece9815a2\",\"/knowledge-medium/src/utils/formatBytes.js\":\"559d908272a40d96\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"eb4e123dbe5b1625\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"4035b2a306185df2\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"8be0e5f21201d1a8\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"d6edeef09a9d0c83\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"2e55b973a1d769f6\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"ebe7da5f128d00c0\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"fb69398ad330ef15\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"f191311beed6698f\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"bf61303a2fabaa7d\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"bee6d1e094b4f8b8\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"4ae5e59ca1ec2bca\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"91b1b19714086b51\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"55b55200c8245e1d\",\"/knowledge-medium/src/utils/markdownParser.js\":\"2d5e104b1d5b62d2\",\"/knowledge-medium/src/utils/memoize.js\":\"70cc8983b81d78dc\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"b3d35bcc6ccf18a1\",\"/knowledge-medium/src/utils/nameList.js\":\"011d174bfa9066ea\",\"/knowledge-medium/src/utils/navigation.js\":\"02a535c001a2fc27\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"a28e857e533f6137\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"cd34a71fc07dfaad\",\"/knowledge-medium/src/utils/panelClearance.js\":\"765607a60926b734\",\"/knowledge-medium/src/utils/panelHistory.js\":\"98b98ac38762eb63\",\"/knowledge-medium/src/utils/panelLanes.js\":\"6bce02b72b1edd8b\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"a0c6c043a9892035\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"344d3ef501dbcc5f\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"8842e59579f0e871\",\"/knowledge-medium/src/utils/platform.js\":\"09939650c8c60f64\",\"/knowledge-medium/src/utils/pluralize.js\":\"396e5f174e338a4a\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"657b0add4e743b48\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"62cc8a9956aaaaae\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"dbce79c2e8273130\",\"/knowledge-medium/src/utils/react.js\":\"64bafeb928961a6a\",\"/knowledge-medium/src/utils/relativeDate.js\":\"5285bdf537e48906\",\"/knowledge-medium/src/utils/relativeTime.js\":\"b6e77d8a195f3319\",\"/knowledge-medium/src/utils/renderScope.js\":\"6b966844dc519873\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"bbafda61c1769e4c\",\"/knowledge-medium/src/utils/routing.js\":\"2fea1b496d1c26a5\",\"/knowledge-medium/src/utils/safeMode.js\":\"3d22f17078686baa\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"a95b7d43ea891862\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"3d976ffb72647d09\",\"/knowledge-medium/src/utils/selection.js\":\"d2f1220e3c62bdd3\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"4a57c3c752b91f1c\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"30fcff1460c0f9e7\",\"/knowledge-medium/src/utils/state.js\":\"19b0a4908f193d73\",\"/knowledge-medium/src/utils/string.js\":\"3e48fa114779eaee\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"194ff8ca2811db3f\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"cfb44fcfc0918ccc\",\"/knowledge-medium/src/utils/toast.js\":\"84e4a2e02cd516a0\",\"/knowledge-medium/src/utils/toggleStore.js\":\"b8e8a3a8d8337377\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"3b3cade2045d2efc\",\"/knowledge-medium/src/utils/userActivity.js\":\"61a65f23922dbf7f\",\"/knowledge-medium/src/utils/viewTransition.js\":\"6450d924ca09c325\",\"/knowledge-medium/src/utils/viewport.js\":\"61c08d5ee0cd8177\",\"/knowledge-medium/src/utils/webLock.js\":\"5d1cb74776516215\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"34f1a2b894c59cae\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"e8f57020ff395a11\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"cbb04963c9bcfcea\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"2dd91b5a8b7c25ba\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"6119e486264fa739\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"7fa7dccbd6c45ac5\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"43c87e673e203ba5\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"37f9fb01f5db05c7\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"b094ceb8b6235aa5\",\"/knowledge-medium/src/vendor/react-dom.js\":\"86f3e020c43eda31\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"abec0267c32fe6a8\",\"/knowledge-medium/src/vendor/react.js\":\"ac99bd7dd0dfe0d8\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
