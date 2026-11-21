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
		buildId: "3d9ebb4ec0d5-4c51668a",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"970339ead2cf2583\",\"/knowledge-medium/index.html\":\"970339ead2cf2583\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-D2UOHZ9D.js\":\"7516fffb1ff766f5\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"62682e7fecb98028\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-Bv-agqtr.js\":\"472bac81c3e3a337\",\"/knowledge-medium/chunks/FacadeVFS-DOiAHsX_.js\":\"4769c59ec505402e\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-Bcg_bj6z.js\":\"f9a8c4c495b4fd0b\",\"/knowledge-medium/chunks/MemoryVFS-BgeflxqV.js\":\"ba248ce438aa96a1\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-C4eKdFDI.js\":\"57e0fa36aa797586\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-CEuqx0tt.js\":\"cda4aef63ced8f6d\",\"/knowledge-medium/chunks/Preview-Q3hviTtu.js\":\"242ed671b16de02a\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-D330yIEx.js\":\"c8a473d8597540d2\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-I4pqMznb.js\":\"48315c555f12c5ac\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-B7ZjkpBL.js\":\"511933d18fb7e3b1\",\"/knowledge-medium/chunks/react-BPtxsbWo.js\":\"a83d9a0033d4524c\",\"/knowledge-medium/chunks/react-C79iBDgi.js\":\"e2a94f7b94725d17\",\"/knowledge-medium/chunks/react-CDddqFFJ.js\":\"02c10c0685f72970\",\"/knowledge-medium/chunks/react-CgOyHiYV.js\":\"e330f1e725360b51\",\"/knowledge-medium/chunks/react-DDOAqm5e.js\":\"c0599a86ec9324dd\",\"/knowledge-medium/chunks/react-DGZq5MnV.js\":\"a02308b4f681945a\",\"/knowledge-medium/chunks/react-DbW5ydI_.js\":\"9cfd36585343fbbb\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-CN3-MP3u.js\":\"8f14f5ce75838a07\",\"/knowledge-medium/chunks/react-dom-server.browser.production-OjzEGhyy.js\":\"541c62d45531110b\",\"/knowledge-medium/chunks/react-dom-server.edge.production-tLWSI9Lh.js\":\"03a0d238d47e04c3\",\"/knowledge-medium/chunks/server.browser-BSziayMt.js\":\"0c9d29556377e4e5\",\"/knowledge-medium/chunks/textarea-QSJNOVbj.js\":\"16ecaf6000ddbff3\",\"/knowledge-medium/chunks/ui-Cyvb-ln9.js\":\"27cc7b30e9c7bed9\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"fb543e60e9837b41\",\"/knowledge-medium/src/appUpdate.js\":\"ecd86a1594d1dd88\",\"/knowledge-medium/src/appVersion.js\":\"97be5bce1ca32606\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"6f8e894cf4707ccb\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"5a9f0aea7b910a12\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"931e04b9265b709b\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"cd7c69bf61224647\",\"/knowledge-medium/src/components/BlockComponent.js\":\"6484e35f2eba1c9a\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"b05fa148a257f10e\",\"/knowledge-medium/src/components/BlockEditor.js\":\"acbe075c3787ed4d\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"46def0e38b944f61\",\"/knowledge-medium/src/components/BlockProperties.js\":\"056cfb606c3798cf\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"ff1171e1a80f808b\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"9edf1cd1d5162c32\",\"/knowledge-medium/src/components/DividerHandle.js\":\"923bc486015025ff\",\"/knowledge-medium/src/components/DraftEditor.js\":\"54cf876a946018c6\",\"/knowledge-medium/src/components/GutterPill.js\":\"d53606d8d02fed46\",\"/knowledge-medium/src/components/Header.js\":\"f0425f7bac6199ef\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"99a97f8db7ffeff6\",\"/knowledge-medium/src/components/Login.js\":\"302504246335b4f0\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"bb43c1b011f9ecb2\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"de44721b0e509461\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"6300e662f4e4ba8c\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"72959406feca735e\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"e5ea61b8c9ec4ca0\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"d1c5e50b96e2771d\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"36207099faff0f5e\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"23fad29b212cc4a2\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"13434633e0fe30a5\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"139d116427044d55\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"5ad7ce5e60ae03d9\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"6fe53c17f0d36fe1\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"2aa643552d2f9381\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"58cdd938cd442f4b\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"b5be5f51700f3d10\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"3327780734b4ee0d\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"5d7d1fb7b310a710\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"f423b43b03f7450e\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"d049b00a20607a53\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"7cb2f6ecd788abd8\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"c9fe9b3c568c2f80\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"2b90f0127d0bbabc\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"7bd3c9a6cdae5c32\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"3761d4c1df93d3a1\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"99efbb39420b001f\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"ca0ac4858e509a39\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"e49b6fc1df567c5c\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"1020b91a9700423d\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"948fd268223629a7\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"64d314346fa61b2f\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"e03e4bc9ed85e04f\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"dfc2d5c4c79cc39f\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"a6fe2825a3253eaf\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"5f455075ec05beac\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"de90aa529ae56beb\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"1a3481c9e146c855\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"eb3a204819b6d6a1\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"18940224c96249cf\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"d555226b4fbeaedf\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"8a64d2b13efa82a2\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"fe1087d1e438b7ae\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"5d330dc27847882e\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"ec1ca6c7385ba135\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"9d82aac474180b85\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"2d16e83567dcc133\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"0ff60be2354eacd1\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"b54aaae3422ad276\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"616514a6c91d0cc4\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"bcc02c3392a52879\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"0120aeb7dd5b9163\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"c02a0511fb7ecd38\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"9cc847751b5ffbae\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"682175782b6c0a42\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"9bec4f163a7c4e09\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"8405094132dda0c4\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"ee106bad4ba47d34\",\"/knowledge-medium/src/components/ui/button.js\":\"0a13c8314c8adaa6\",\"/knowledge-medium/src/components/ui/card.js\":\"b46d697c8c5a83a1\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"84348646c1909982\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"4645fc5739e310e0\",\"/knowledge-medium/src/components/ui/command.js\":\"067b74d524fe114a\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"8f2408909ca54f7b\",\"/knowledge-medium/src/components/ui/dialog.js\":\"fc93372d723bf982\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"176012c77378699b\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"776825d97c94e906\",\"/knowledge-medium/src/components/ui/index.js\":\"95831d6cb05b9885\",\"/knowledge-medium/src/components/ui/input.js\":\"ba72b13afcd6c482\",\"/knowledge-medium/src/components/ui/kbd.js\":\"9a24fa97d853c6c1\",\"/knowledge-medium/src/components/ui/label.js\":\"d03297de7b64415c\",\"/knowledge-medium/src/components/ui/textarea.js\":\"c006cbe13987fa29\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"3d5685e11b799d23\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"cf067e0e494bf457\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"04d9be0867e1385a\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"6ce2a3fa9952612b\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"ce5199a05c877660\",\"/knowledge-medium/src/components/util/error.js\":\"d179417c0e5e4428\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"b110918cc5973cec\",\"/knowledge-medium/src/components/util/suspense.js\":\"56551f04efb8fc89\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"0b838124c91376cf\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"471013159dd9f387\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"8b36a153446da20b\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"f4e999c3ce6e23f2\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"4b7d171a1adc1e00\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"717a8370f12aebe3\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"d56e1afc79cc6b30\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"f9dc210143a4d6af\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"cb593dfbaa544b93\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"12b68fe481056d27\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"eb08c8cdcbaa51f6\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"084265e486567be4\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"543f0d363199419d\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"386b1e008e2fb14b\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"c555442e0892f2ab\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"0c04f93f3f960836\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"b33136e04dd4b72e\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"2b0622cab268e8d1\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"ccea2795f721b390\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"2fa8da544d55d9c8\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"5af7f929da742e83\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"84848b23be60377d\",\"/knowledge-medium/src/context/block.js\":\"1016e8f2212061e9\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"8847bd95b647c08f\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"169bca7459ba7702\",\"/knowledge-medium/src/context/repo.js\":\"6ed99fc92b964d70\",\"/knowledge-medium/src/data/aliasClaim.js\":\"ca56f01ee16d8c3f\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"0d85f502d69f4085\",\"/knowledge-medium/src/data/api/blockData.js\":\"c245f75bf62393fe\",\"/knowledge-medium/src/data/api/blockType.js\":\"5eff710a8d9e0b51\",\"/knowledge-medium/src/data/api/changeScope.js\":\"a0627732b0f428fd\",\"/knowledge-medium/src/data/api/codecs.js\":\"783c047890ba45dc\",\"/knowledge-medium/src/data/api/derivedData.js\":\"ea493f518a25c13e\",\"/knowledge-medium/src/data/api/errors.js\":\"fe36f777c83c57a5\",\"/knowledge-medium/src/data/api/events.js\":\"634f9ffdf860659c\",\"/knowledge-medium/src/data/api/handle.js\":\"d69151e28b772b2d\",\"/knowledge-medium/src/data/api/index.js\":\"7a501d015315b825\",\"/knowledge-medium/src/data/api/mutator.js\":\"62bbff6eb13a8006\",\"/knowledge-medium/src/data/api/processor.js\":\"bf8109e0e526c420\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"2cb4b72e1c996256\",\"/knowledge-medium/src/data/api/query.js\":\"edce728be554b3f6\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"1511b33cd9d2a8c7\",\"/knowledge-medium/src/data/api/schema.js\":\"d69151e28b772b2d\",\"/knowledge-medium/src/data/api/tx.js\":\"d69151e28b772b2d\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"c9ecfa8d9ff4db69\",\"/knowledge-medium/src/data/api/user.js\":\"8e89bed0d7654080\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"c4d5b9afc987c77d\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"3604fc77abe42e87\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"46b286b671d49b25\",\"/knowledge-medium/src/data/block.js\":\"6aeab1234bd154d0\",\"/knowledge-medium/src/data/blockCache.js\":\"1f68559128b3386e\",\"/knowledge-medium/src/data/blockId.js\":\"ca8cb363500d5fbd\",\"/knowledge-medium/src/data/blockLiveness.js\":\"51a57dec4f9b71e4\",\"/knowledge-medium/src/data/blockMerge.js\":\"a9e290c773e6b845\",\"/knowledge-medium/src/data/blockSchema.js\":\"64da5aa431083988\",\"/knowledge-medium/src/data/blockTypes.js\":\"9d5356faaf96d32a\",\"/knowledge-medium/src/data/clientContext.js\":\"c8c4d2eddf6caf0a\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"82562b17539f0e88\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"78a8b445a18c68a4\",\"/knowledge-medium/src/data/derivedIds.js\":\"667609852bf50d70\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"61caf5a880417299\",\"/knowledge-medium/src/data/facetBridge.js\":\"4ff647fec9d5178f\",\"/knowledge-medium/src/data/facets.js\":\"663029af312c32b1\",\"/knowledge-medium/src/data/globalState.js\":\"462946f052b7b6ba\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"d1c48c4af19a47b0\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"da6c3cc9b10fda69\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"41df76aadb2672c1\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"174baa53ebf0266b\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"c9f8c2a72e157aeb\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"737ce30833311b2b\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"953fc3645fa66a21\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"7d89d70331a7220e\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"54d7a5c9976818b7\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"26d1b68176b4b7e5\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"9a74b458fd43b4c9\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"b4a0fe8f773befdf\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"988cead75fc989e5\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"49718202e08888f3\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"db74fa60b406c64d\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"b46c845c75c97348\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"7d4c64e0bc38a24e\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"e855e7c0f78b1ac5\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"5e3497fb145537cc\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"2a64c768402830ee\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"fee3ce1f15f04ec3\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"088548e588f90709\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"260789172777a9fb\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"3c6d88468211d7d2\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"182681923b091264\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"46e4f886215fbacc\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"5f9d7b566c3eb7d4\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"4a7c300640c8590c\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"982f5382376143ee\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"b99ced327f8049d6\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"e6f3e073e27a82ae\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"2b6918cc759d6dee\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"46b1f15e2ec4ecd3\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"e85a30cbf63eeb70\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"d293c252554a6c37\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"bbe966c0f489604c\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"cf015db215045d7e\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"5ab749f67d9cff70\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"529d572fd28d0c07\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"f61c4d1bb2dcfeed\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"161b81cc9dbc6b73\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"160b0ffb5dff7d49\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"50a5785d9dc211df\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"4e7ba5d9f5bd488b\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"fe332c23fcd68b74\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"804f081128bb0e3c\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"239ce38d6bb58140\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"88b5fa123a5806c0\",\"/knowledge-medium/src/data/invalidation.js\":\"6590ee61f0aaf044\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"52b60e7793365e0f\",\"/knowledge-medium/src/data/kernelPage.js\":\"ccdb657a87fe738a\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"3fce0a75386d6c06\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"ceb2085f91e4c7e1\",\"/knowledge-medium/src/data/localDbStorage.js\":\"6bde529df057e85c\",\"/knowledge-medium/src/data/localDbVfs.js\":\"2201fb04dfad688d\",\"/knowledge-medium/src/data/localSchema.js\":\"6db1630c5ed0cdb5\",\"/knowledge-medium/src/data/maintenance.js\":\"d1ae273bb226504b\",\"/knowledge-medium/src/data/mergeProperties.js\":\"daa163eef604bec4\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"490ab2185bdc7eea\",\"/knowledge-medium/src/data/migrationsPage.js\":\"8a5dcd5730225f9e\",\"/knowledge-medium/src/data/mutators.js\":\"ae2ac6a9e01952d6\",\"/knowledge-medium/src/data/orderKey.js\":\"31105ca28c54ed4c\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"11c7e08e4b4b9b51\",\"/knowledge-medium/src/data/outlineSurface.js\":\"cffa92d679e3ef51\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"ecc4261f6f1ef74a\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"a0d9432073d4b32b\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"cb69cedc6c278848\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"43e55215f73f51fd\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"a09f1b7c4944f068\",\"/knowledge-medium/src/data/properties.js\":\"c7b7199d295e8573\",\"/knowledge-medium/src/data/propertiesPage.js\":\"27191ad55e97723b\",\"/knowledge-medium/src/data/propertyChildren.js\":\"1e5f44cb973490b7\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"69c378b542adc826\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"27581ee40e65c384\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"c55c6a601679e13e\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"245382980a60d1ae\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"1493acf92d85bafe\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"08cf0e81b07dc328\",\"/knowledge-medium/src/data/propertySeeds.js\":\"78ce87bffc640748\",\"/knowledge-medium/src/data/recentsPage.js\":\"6bd88932684b660a\",\"/knowledge-medium/src/data/referenceBlock.js\":\"f5e67e706ecc5423\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"b292741ba4a268ac\",\"/knowledge-medium/src/data/repo.js\":\"158b7adc9d3917e9\",\"/knowledge-medium/src/data/repoProvider.js\":\"6340a18142603224\",\"/knowledge-medium/src/data/rowProperty.js\":\"13653b671787e9cb\",\"/knowledge-medium/src/data/searchFilter.js\":\"3dd8c5e8fa800858\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"a78478db1a1848b0\",\"/knowledge-medium/src/data/stateBlocks.js\":\"d67bd937eb490c7f\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"6f5587fadf8dd9c2\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"91cd28a497c9a36f\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"69af71d4a96913ac\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"f869d63d13e3e343\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"bbf26a996fa00a2b\",\"/knowledge-medium/src/data/targets.js\":\"862090916f6044e8\",\"/knowledge-medium/src/data/typeColors.js\":\"edbbac6fb3ef11f9\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"d327c894ba953e92\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"ce50de4eebefe29e\",\"/knowledge-medium/src/data/typeExtraction.js\":\"f742c06064f7fdc8\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"2f3e7e2d9cbd9056\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"44fb6b0f55929b90\",\"/knowledge-medium/src/data/typeSeeds.js\":\"79d18255c9460893\",\"/knowledge-medium/src/data/typeTagger.js\":\"d1bd72b06ac313f7\",\"/knowledge-medium/src/data/typedRecords.js\":\"5a52ec3b7611b102\",\"/knowledge-medium/src/data/typesPage.js\":\"32c358dddbf710b7\",\"/knowledge-medium/src/data/userPrefs.js\":\"80c59dd8ed7234bb\",\"/knowledge-medium/src/data/userSchemasService.js\":\"a0201b22dcc33d8d\",\"/knowledge-medium/src/data/userTypesService.js\":\"306663e5badd0314\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"bd1963ed3c3a2ebc\",\"/knowledge-medium/src/data/visibleChildren.js\":\"876f5807a333e91f\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"1b622e13ca870481\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"a5e42e68fc76af3b\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"aa3fbb07f6f08cab\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"05ba711a51c1d66e\",\"/knowledge-medium/src/data/workspaces.js\":\"4a1cc61b9e98a44f\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"106a2654f89c2300\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"2448545eda72180c\",\"/knowledge-medium/src/editor/atTrigger.js\":\"5ae8978734d0a0fd\",\"/knowledge-medium/src/editor/autocomplete.js\":\"d268bd04e0e9f657\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"992d785703c21238\",\"/knowledge-medium/src/editor/contentFlush.js\":\"89adfebdfdabf2aa\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"f3641ca76047829d\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"babc655c6930c2fa\",\"/knowledge-medium/src/editor/insertImage.js\":\"67668171cd97f492\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"fed1b0a2729efe25\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"d66911788e6efcf8\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"aa49297ebdcb7603\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"9883e63fc25a6d05\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"fe2799c65eac3cf7\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"0e85dfa25283d63a\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"554524e9ac77fa2a\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"3efbfeaf7c767634\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"4d73e72170f09fd9\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"44bddc77fbddef0c\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"b628426c5a5a0186\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"d4b713c395808515\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"b7e43adecaab2822\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"01a5c93bea37ee31\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"917a3db67c4bc0b4\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"a1815d58424e6cc5\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"2d65e18e337b367d\",\"/knowledge-medium/src/extensions/core.js\":\"7639904e99b56068\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"317c571c286bfedd\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"d1fd2e474517783f\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"3ca2ac14d11345f1\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"89c83286410a5ce5\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"39fb0ba37f663f3a\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"7ea799cbb873d43d\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"96619fabae320441\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"93dd4ef81b16e509\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"756379f012a13025\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"832e649168fee97a\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"de5394bb0564d666\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"bead322af8cc469f\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"768bae34e70c605c\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"3c8a80f7c4432b9b\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"8ace1e1f39540a3a\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"84612b1b9af479c8\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"ed02d55df2d28129\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"01388c68a175126c\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"2f0c687017deba9b\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"b8c02839b16e4355\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"a420803b9d2a0d5f\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"5bfee2436742f82a\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"16870a50d4ca05d1\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"c43150e5f4dc2784\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"4ff25a57c15001ac\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"9a326101a902997e\",\"/knowledge-medium/src/facets/facet.js\":\"2883074072940c73\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"67d5961258860e7e\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"e7f4ead7375e8ab9\",\"/knowledge-medium/src/facets/togglable.js\":\"03b92b157956bd0b\",\"/knowledge-medium/src/facets/variantFacet.js\":\"ab0bb3a564cadfb1\",\"/knowledge-medium/src/facets/verbFacet.js\":\"fe8735ec300c5b0a\",\"/knowledge-medium/src/hooks/block.js\":\"e9a7890701864b82\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"d8687d52dc0daece\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"6a7de66bd9bd6bf0\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"5ea90a019df0cb73\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"f041e3659bcb96e4\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"4c172c63933cb5cb\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"fa25ad457e26ad19\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"202fab5b469f75ce\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"11ca55beb0cbcea3\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"0be7f951e4ac2f29\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"2f5364d7e76df7ac\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"7a7ffb2f1c6661b7\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"7296550644e533f8\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"d7127f6b35447bd2\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"dcb4070981c81438\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"729251199bad6a2d\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"ddbf86903077e803\",\"/knowledge-medium/src/lib/utils.js\":\"20feb0de57aea32e\",\"/knowledge-medium/src/main.js\":\"4b75cc3f76271436\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"564fffee4b916465\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"5a4f335ceb8e305b\",\"/knowledge-medium/src/markdown/context.js\":\"52ca876af6c5bf93\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"318292b3857e7848\",\"/knowledge-medium/src/markdown/extensions.js\":\"3c755cbb7591aa09\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"e826599796c0a538\",\"/knowledge-medium/src/minimal-editor.js\":\"69b12c6d145ec58b\",\"/knowledge-medium/src/paste/armedCut.js\":\"fe7065cce65d68b1\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"54bfdfd986129b02\",\"/knowledge-medium/src/paste/clipboard.js\":\"b5b4775ba9ef0a0d\",\"/knowledge-medium/src/paste/decision.js\":\"6ff7b2ebded91d2d\",\"/knowledge-medium/src/paste/operations.js\":\"dde8edeb827819cb\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"eef2490252a21506\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"750bbded90028ba7\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"33721240294d3ede\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"e8aa47e402cf4cee\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"8e05f2e638957b24\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"f15b64d7cfce3bb4\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"9a608b997cbdbb2e\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"2ea838fb3fdc90ea\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"e2d33f9a5f33120a\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"a60575aae79d0414\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"b8ecc3d74d6d20e3\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"d806140b9ca14dc6\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"35cc5185b94820b0\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"63fa6d6050d60b7d\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"c53441f09632a615\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"124e5031267217fe\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"47ec8352275394a6\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"cd096e1a014dd93b\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"6c77722c84f3ce5b\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"d383bacb7dc99a9e\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"694b25997c8585b2\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"c286f1459779c3fe\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"6782863d314936c8\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"304c243ba67f9919\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"98b1b658891893cd\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"9bfaed2380ef06e2\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"8f2e9aa384c99fe5\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"488390257ef996d9\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"005ba03ae77b378e\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"f796977791b2f6fe\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"446a5269a5e1f061\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"19d0eb3af148a7ab\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"7198af283d2525d5\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"b7af2e01a23ef9c4\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"e191e3bbc18b2b31\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"98225873de920ec1\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"0268aeb7817fead1\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"521a6ada09688279\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"be2ccbfc9720d1d3\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"53b0f703d3a9c865\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"73d01c505833a9f0\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"b771395aa7115195\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"353b91eab96b1404\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"2ee86b639964cc43\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"626e4dfadf22e62c\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"809f646ee38e4a64\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"b8ee6a8cbf1c3c87\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"810b6f259581d76e\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"78701e0127357aba\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"8d5d3ff82e253a5e\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"85d94944a8bbaa32\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"ded91250d28ba995\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"549e65fd6c738b90\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"4a78e575d806d93e\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"a69efcc097b65e43\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"7c6367997f6426d3\",\"/knowledge-medium/src/plugins/alias/index.js\":\"9ab184fb5b9c9dff\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"661fe7cb7eaa57e3\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"ec40c3d7fc6e2b0c\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"5553bfbc4c96c703\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"62426086f3465478\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"3880a46cb1872add\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"6c8ec27078c9a6e5\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"9af5326891d47aa2\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"2f9441f4d1e1c34e\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"600a329980e483e2\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"647869f2c3fc60c7\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"e8780d4d8dcc67f3\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"1a20ab2f47fc1130\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"0c4ac735bfbeb2ba\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"98a93c935b0888bb\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"2e65a27edc77d861\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"589e0cdc664875fb\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"9516fb530f7ffa4b\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"c78b4c20b8a10568\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"44d048f9cfd6c7f6\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"13820c610266dd93\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"845dd0c632cb59bb\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"13347e5c229c5632\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"47f6aa491e589b18\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"1435d7c0623ee74f\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"76dc08625e285c43\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"30e4174c3cba5e82\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"26cbaa8d8b325f2c\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"3e533c9f0a516053\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"5b02f18ae2b2d94c\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"09c319724a569a36\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"b3df36add53e08f6\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"72d87d63e0db47ad\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"91f24cfd0265f142\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"f76698fe5f12ff43\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"e98ef246408e8d85\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"a6956043e6ffcba6\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"aa0ca53b73297c88\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"5af07a3d65c44f45\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"292d21c97c67ba41\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"1ee0b0d2ded3c26f\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"3e18c83c97363427\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"59f532d363765c32\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"21bf8a8f0f07422b\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"f429d9ed9ec47b1a\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"fe75d838a3a58525\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"411696c21edd2b8e\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"f3df8f74ccebc907\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"e1134a84457c097d\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"c6a558c7461089de\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"d036b689a96a2948\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"3a92cc566bed9d56\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"ec1f8f00b023be4d\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"19aa93623eaea7aa\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"b829390284f3135d\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"e1bb2f9991564f36\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"5edc0ab533696869\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"fc4bdfb9125fbcfb\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"4cd437f753d46239\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"79483f8420c465e9\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"d174e07ba27073d1\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"d545be4c1076c189\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"bd4d8c52920ed56d\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"1355d67dcbf18ce5\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"7763977a94eb6edc\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"e09f5f1f0395cb6c\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"65b3b8bdc6fa367a\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"5867d8abaaab3aee\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"4d294c8bf7b7fe6b\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"648cfbf91f045b2b\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"f5588f1a28af66c0\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"271b83ae9cededd9\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"5cf9b1615c2e9f88\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"b96c2a515a6e636d\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"a61168fb1ecde376\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"29afbeee3fc7a77d\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"d9699b0cae1d3b14\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"08747ace7e0c9c47\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"74e5e0b249bec33f\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"76ccea1393b15379\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"2fb2872c1db9310f\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"cee073d977d871bd\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"c5188d56d02b902b\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"a580fac0d6b22686\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"422b29239f3de6fa\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"fc1df92c6f09fc09\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"32d6c33f5bea0457\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"dc51f43fffb28fd8\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"b5d67f04c6d5f2c3\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"43ea9c711db82e66\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"5b9f6b6ca855f31c\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"0fc4323597fd57b2\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"98a466fccfc3c2f1\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"666a7e6a0f281021\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"3b1f16d0b197cca8\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"037508f0d4e81e55\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"64be839d065a5968\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"c44c8ac671f3816c\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"26dcb76030baa556\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"4b42e42b1ffc8050\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"a2c71496bbe7c6c9\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"3bb284f58c620502\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"14fb5ffda3ee1492\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"b552c5f3301e8f32\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"cf750bb21af7efe5\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"f00f5ab9175b991a\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"471eb453dd8c1e25\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"edab1ab575f88534\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"4955e642a6fd91b6\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"226c67b3eb62a0f1\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"4002f034cd0932d0\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"8bfd704340235462\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"614ab6059d745e0b\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"287ac9149f886a45\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"27cb10fecc074c3f\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"855a8080fb8afe3f\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"d31f8594a88b301b\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"89a16b1a729fa3bf\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"a1ce202aface0df7\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"8ec797956b3fcfba\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"d25b81f455f2d0fd\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"467067723f875493\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"6a5aa36a83ae8f45\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"56c423da1faa4719\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"5d554c17b04a802e\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"21b70b09bf2caeec\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"ad8dbf3e9f9d1102\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"e5c03462d5ef0f38\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"bb20bbb229b7fdf0\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"a7f5f1cc23dbedc5\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"e74601bc87b52ce8\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"8502014dcf4a9ebe\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"1c26a8f6f8cea362\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"c14d8c29858656b5\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"ea355679c9fbcc75\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"a0a0ea4d3ca6b28d\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"677234b3373d72a8\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"916d5fe66b5b63d3\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"26db5bb43c890def\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"9a882759be1e767e\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"cb3620f2466d369a\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"d3cb6b7815d7fa3e\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"69c9bb2450168331\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"87e114d33fd0cb4b\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"8ec6e76e8558f724\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"758d062e57dbd3d5\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"296a725b348330c1\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"5ef3e84145dd2289\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"105b04aeea112726\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"e5f665109c8163ac\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"4bd338626bd4e325\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"da2c56410ad6b79e\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"c0ed6a1d4209cff9\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"fbcbe624900aa676\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"09ef2d94863cde91\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"a6d5f241b90a9e03\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"ec7a2c67eb3ecfe2\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"3792eac80a3774ae\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"8e38c13b5435c9cd\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"0e2cf6c93ab1aacf\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"e6641d6111bed7a3\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"c0e1f982de3ab281\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"c7935f5a97c3d135\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"964e200c38588748\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"0331d578cc054a93\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"25ffd8dac1f7523d\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"ead1aa9994718c03\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"ddd1bd8dd78d9f22\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"b661769dc3dea68c\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"d552e599b85e5143\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"bfa4768bd7c19618\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"f33bc6da8b41fc28\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"1ad712bd712b4824\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"b1876bea31334903\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"c73ba8780207fbd0\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"3e5ab68c6dd86572\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"bceb66ea07e2a17a\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"e5dac6af134315a3\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"491cc12ea391dbb4\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"a6bb50c6830e9b74\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"45c01f1377031bef\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"a89ef5e32c7211ed\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"a0355398f66d9155\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"181128c7c96e5e6d\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"d35612bbdb8db1a4\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"98d8a55657a4139a\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"26fb781961a59086\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"77941b11d0b11142\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"b3c37f77531014fe\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"8db1688bcb0546a8\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"5571cdc712e29131\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"c3cef58b4047da64\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"48882b5dc23e81a1\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"702660f35d669cc9\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"e6551f34900b98cb\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"cb0a5284851fe337\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"03995454253921e6\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"c1e02003f36d9a95\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"a55314c941e18124\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"2e65195d8f5c512e\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"9a2e948abca68c09\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"1e02abb9681e3723\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"a611128ae28726e9\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"df7adab21aee2313\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"864a7b14a116ed42\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"5180a7f45926a079\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"e66d875976925871\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"31d86166839f456e\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"c04957ffecd68e7a\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"a2ce4aa3a7a999c7\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"6ea1fc1be568b77e\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"f9e1f976f3848644\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"e0b45e099b6b08f6\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"b13a81289f38118c\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"e3a21579152aebfb\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"5c103691f1f767e6\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"c58f3904d48a531f\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"715fcf17a4a9b42a\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"3db45d473121e435\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"d76ae91e518cf5f8\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"2f19f8450f741d66\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"58a8a022a4d6a543\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"a681273b61ee909c\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"186fbdcef8bc3966\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"89fba2c2de99d8ce\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"b4f9acce02a453ab\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"593627b811ac92b4\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"94d7453dbe1cfa94\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"b6a6eca650f76123\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"dc6271d68729341d\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"7fcf3c21a0648cc4\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"6384c4f7a1916684\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"802653a756bf9d4b\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"aadbc78991295832\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"9cbddbd612ecac81\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"8bbca0dcabe4ec08\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"497b2e0c5f765d36\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"da00db8eac07c53e\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"6f23d3e057ebd3d3\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"f698d8f6d799ad7b\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"37f48abccccd0a26\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"a7b4cff43c1e5965\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"920e2036f413f9ca\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"2c1a23a273e7df47\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"4285920e1c21451d\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"5d3559a3d8c39c5b\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"86a9dfa2b04e0aaa\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"093682fb8e8bfa59\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"727d7df4b24ed96d\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"71cd8ffd9d75d05c\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"75b83d87bd8d7af1\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"23e8c49b5e6a01a1\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"ac9cb78efccaa6c7\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"6216d0bd3098c57b\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"a831eb634cba85ca\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"134bb449a76ff993\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"9c6657ec7094e123\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"e2d984139cc8e18b\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"d937dd0653f91ea7\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"f266f4a709320aa4\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"5f8917790fc088b2\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"b59e18074f503192\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"714d5c61830b2b34\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"57d848f7252e509f\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"ea6d3e51a5cafa39\",\"/knowledge-medium/src/plugins/geo/index.js\":\"c9a17ec03aeb060d\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"20851b7a56877d50\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"e5f526c1dfac1e61\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"ddd073b1e0888c37\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"fbc9ad208c8044e9\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"4a92d5fa428a574c\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"2c781ba99f4214a2\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"884592ad1e093559\",\"/knowledge-medium/src/plugins/geo/query.js\":\"a0748a71a39bd4ac\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"387fffdc4ac5e41f\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"2490f76e932ded19\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"1bea87ebe363d14f\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"abadfbb149b49aee\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"fb3fbb1aa5ed8c9a\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"8457b5e8f66224d0\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"c7ca010434c5e911\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"d35f68d9dfc466ba\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"3610b2666a33ba88\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"152b981e44496709\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"705b9fe09ebe963b\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"fa01144b91def00c\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"2a5d971294642a4e\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"837dce5850f42801\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"529ce882d6235cba\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"d05e687bd55d6e8b\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"30886147b4814333\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"8f85ed2c6cf86fcd\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"62f2083e574da685\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"b9bd9b7392c925fa\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"a75c3e019bc8c0bb\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"97e57929602dd7c7\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"02a00676cc6e29c3\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"88bb5deebdf700bd\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"f54a987644626a43\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"b2c503fe5e22d7de\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"4c450489922e4fb1\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"ed11c5effc2e6456\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"c0dace0f89704e1a\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"a43891d6b7fd8ab6\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"2b137ab076e23815\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"540bc0f9684d7b14\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"7c7d71ea8e1dacf4\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"81e352addc3e39f9\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"bbcee46a1aa4e3c0\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"316ebadafbf4a2d3\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"dfa3477e09f972a2\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"1f96a25d87a25136\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"4e9bc80e58faa21c\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"288924b85f24f256\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"f928ea1077b631ec\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"ec17068523656a6c\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"01ca0771a31c8069\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"75530cea2137f7fb\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"f24295a376f1146b\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"b2860344d9041fed\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"86b3ff9822524ecf\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"d1146265eae0a46a\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"fe5517964b1d5f5c\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"55916b6cb022b607\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"adf3cae5d3e2035e\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"170a1d1c2ec3db1d\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"c00b60dd63a065cf\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"8079b9aaae2cffef\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"e5103c4aa5a52b17\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"77dca31a112a5e6f\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"5f0ef74147543be3\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"f26f4f9b8805bcb2\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"b6588050c959512e\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"83e823d900375099\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"734e9bd33f2289cc\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"80a84f190cb43f96\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"005730d01ea824e6\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"7a13bbaa856f0713\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"db8405a3e6d40da7\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"8728d51effda6b5e\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"c17c27e8dd5a72f5\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"e8784bcbe507d216\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"82c4d8b334a29498\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"849986b015b8dec0\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"14dd07fe5ce36dab\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"3ab7a85f0a51131f\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"72b06642ca7301d0\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"a20d87c52452080e\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"12938762c4db7ccd\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"fc242652cc478f53\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"eed145a06f83e55c\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"f9481f93d3d5c7d1\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"a36e0aa9287cc674\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"c1a4b4804d32ffdc\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"48b177023007295d\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"c7b0eed678196cbd\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"5a75fa2d42bfb5ce\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"ff02ae3548ee9286\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"4408df078b08fd6e\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"64e965b0d2040842\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"48bbfaa6ed555479\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"4c47739d12653839\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"e819e6e92d26272f\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"6158a5e4c76b79ec\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"68f63add6c114bdd\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"d49d1cd34c711598\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"ed491ce73598047f\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"a0713f28c2c853e0\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"09350687fd82fb95\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"a0577259ccc36d42\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"95bebc778950eee0\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"996ddca898b1da27\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"963566c5944828ed\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"4ce26640ede4dd3d\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"5e38ef718aaca843\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"6c921dbcbf0e0225\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"a80ad992db81f91c\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"04aa811fdd56e2cd\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"7f68a1051a9bfa84\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"d793c2780ab0945a\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"35be49e2d7836b40\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"f9b4e4ef88ef1bfe\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"b9e1e9dc8d9def8b\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"fe4c8112748c6fa9\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"f36f628eb0c00b99\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"1515cd482e6479cb\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"cb2dc0ce65c3cdba\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"a89645ff1ab7dcaf\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"331371bd91c0e285\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"78c38b6fc8bdd916\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"6f0c0d3b904ac938\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"83b38c4d4fb47547\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"79d3b4f89f2e68a5\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"a25efb0e2b5b4548\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"c0230931508ca607\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"5c2beff33254c3c5\",\"/knowledge-medium/src/plugins/recents/index.js\":\"5cf8e6fcf1f2e821\",\"/knowledge-medium/src/plugins/recents/target.js\":\"9126ab4ee0917e29\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"4d5bffb98751ea4e\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"8e783adb30224fbb\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"4cc4af62113fa02d\",\"/knowledge-medium/src/plugins/references/index.js\":\"3c9f5a870cb64da3\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"7dcfe9927da332b8\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"6344f816df72df07\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"f4f872de8d7514d7\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"4ab4015fe199d087\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"5e4afe7edf8ed5a7\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"0b72704fe90189dd\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"ef66426b6b19ceff\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"e80c5d9350f39ef5\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"b835eb91452965ad\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"afd53a28bd870f8c\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"266ce8d370d548dd\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"3c109fc818bc5cab\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"13a28a75e264259f\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"5e1e2ab1f26bb8f3\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"0b077f8eb8c228b6\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"c56eb456c6c8fe08\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"0d3772540a107d1a\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"0a08a4d8608eaf17\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"f717d0c24d80665a\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"9205a3a64e9e7903\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"d699fbbe4454cd61\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"8d4344febe5edc7e\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"ad35dba7db771815\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"69fd690aa3b52f6b\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"e2dd96a1de9bdc39\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"fa1f62f1596ffba8\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"2db976aadfefd31b\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"872ace719912dbc3\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"f31a0904d41b40bf\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"15843d3535ae6cca\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"c6dac6fa62c5f133\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"633355e7e838195a\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"c75f2e3a985755d5\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"13ab05cd57ab2d5b\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"d49ddcbb4fb455d3\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"8eb552a6cb64b8a8\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"6f964310112ae05a\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"3a44333f26a1265e\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"c51f25c4e6a3b168\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"85741b72221c8547\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"975f9886c69a494c\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"01f0bd0c448ebe11\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"b0e154b5d0d19a7e\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"38a2d787d62d9a86\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"f86b4dbd0127eb12\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"6e4b9c6777f116fc\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"e134c8e86c6ea8e5\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"3e1397566b5dff08\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"f01e85aed92f3564\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"0b19455a8206193b\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"7456952b0aa9b3cf\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"faf2083e460c8cbd\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"293176fc5c57fabd\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"918415ef8927a797\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"f009d6ba1371eed0\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"e8ba896006df9796\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"53c5069aace37a72\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"24954ab7f6768955\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"ae675110c31f6075\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"f0c5f76bf10a24b4\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"2ec3a41c31d4ca2f\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"b8583f9819ab48d0\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"f9106ad5d1a1b386\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"0f2526e7ed19a7d1\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"64a0617b58c976fa\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"19df652c51a224fe\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"64bf160be901d3b9\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"e491f1f6a0ff20ee\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"f9b56c2295191cbf\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"13ac8b2dc45febe5\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"f7b2885c062019ab\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"c0a4a9cf81fb2b48\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"c731beb967d50ff8\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"4228c1cf7c3acc35\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"aee8fd6850248e28\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"3d45aff2103e26e2\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"a4e7722b7212f54c\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"298d4e81cba0b1c6\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"702a41e6a7cc3b0a\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"435172592a8183f6\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"21ed174fc28241a4\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"02f95c01ef6e3352\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"bf93b4407e8326c2\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"c731a74b9d7ee304\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"c227a39284cbafec\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"562fcd8629cd0162\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"fca57ac3c9800450\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"27b397d99ecfeb1c\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"6cadcffcaf8ddda2\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"fe848dbbf34f7942\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"2055187427c4dba6\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"ec2ec88b3a70b267\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"443de326acfdfaa4\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"7e8acb38f82bb672\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"ce8f9f4dc30e00ce\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"9fee90c06cc91aaf\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"90fbf5a727f29f8c\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"d462548748546cd8\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"6875fcfecbe03610\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"bcdf6fd65bc9dc9e\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"b46553734a615015\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"a0e03935d3ec04e1\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"4785ec1cd9456a11\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"00e8e86a57d98e3f\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"ff65a23ed4a828dc\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"1276095df0d9a901\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"3b6f462201215036\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"073b654cb2d25b79\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"21fccf855efb4e65\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"510af3fa62f72d33\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"3917c8bc0fad8a9e\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"13f4f66c70b2c1c4\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"94459e9dabcb8d42\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"5f603ab301251ab3\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"cfeb16ff7df1440e\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"40a187227a21ffcb\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"a8387bd39a52c3f3\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"8288f4723556ddf4\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"70410cd602c9e38c\",\"/knowledge-medium/src/plugins/todo/index.js\":\"6eaf3d09c36eeb98\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"27aee357ba496d7b\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"b962e35b2003922d\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"c39da441ce04c0ee\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"9f8d02f1b35c231c\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"9608d93fe711509d\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"51ae6c1da3b77be5\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"6c9ea952120bdcbf\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"6393459cb2cd50a7\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"648d83e3ea2eac00\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"2f6058b93e9ab9fe\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"b11ef7e9ce846eab\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"5097b449f27ffa7f\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"f87560362eab9323\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"3b06e7c33302ac8c\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"4ef271dfcbf88c69\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"b3ec6c55a1b51dad\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"988de790bd246026\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"0e5521d44fe4c3ee\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"15b6ee5112f51e19\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"3d788046a7a6bf95\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"368773df65125abc\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"d4f97dd06dfb1f2c\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"84ff7cea6c89c878\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"9022fc38d6f021b3\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"d6927c99b8937b7d\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"7f86beb824ea95c7\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"7ac2ca790d068d92\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"bfe6f55755839252\",\"/knowledge-medium/src/registerServiceWorker.js\":\"4ff4a52a5448180d\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"0322aefcc512b9fd\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"fa1679e6b3a10d98\",\"/knowledge-medium/src/services/authStorage.js\":\"30b51cdf3b218f74\",\"/knowledge-medium/src/services/powersync.js\":\"a66ab4715caea5dc\",\"/knowledge-medium/src/services/supabase.js\":\"f789e2c0a34b9b53\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"cabb335f43f6dd5d\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"2876fd247915ecc0\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"12cf50cc65ec5b57\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"55aad97fd0826308\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"2ce1eba193229a8d\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"945667e1da04ae80\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"c7f30db711192a2f\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"aae0f93cf4837a4c\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"04f2a1dbddb49a0c\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"8bc7beb52c590f50\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"e446bb07ce922531\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"0d1e5457c0f20a77\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"ce033c9012bd58dd\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"9f9b7f44c83bf431\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"8779176962212ca5\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"dacdc2a6515cbab4\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"999513c3a7b4a7bb\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"129e8d092dcd623f\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"29448c98ffb0113e\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"aee42ee481a91b30\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"5236b0cdb09d4607\",\"/knowledge-medium/src/shortcuts/types.js\":\"0c293b5c7c4c7c32\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"cb56da938cd682ea\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"604c6afdc9da4887\",\"/knowledge-medium/src/shortcuts/utils.js\":\"db684f0b9697d688\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"7c35cef80d9e53e8\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"736d3ffd19098a51\",\"/knowledge-medium/src/sync/byteTransform.js\":\"718de682ca8430fc\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"4b7d757078c25cdc\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"64cd5ca1364048a3\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"dd56e1af4f2c2545\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"4fa10120819079bd\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"5c8388c9dca2cb45\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"05bbb729c66ba5bb\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"71dcb8573a614739\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"49d40571fba7e9f4\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"df8a2a9337c0b871\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"3bb7dcf1877c1a99\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"18e19e7fd2e7fbc7\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"5edafb2b6448e649\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"2e6171a11c55b63f\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"7af6c3489a72abc0\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"20a7989034a60a0b\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"559a072a1abb22ca\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"44698715fc6e4f27\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"ab4808b8cd978c7b\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"bcc561ff17fd2177\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"ea710a134e338de6\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"ca032b1f545d2d9b\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"ca1bbce71d23ade6\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"fa0c1fbc3dd13d03\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"a146851621bbadc9\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"1eaa71ff33a395ff\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"e01a53df92505a8a\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"d0b2093ea96a354b\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"65076ec5639a5802\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"50450cf857c8bd5a\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"b8fedc6873d5871d\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"25ad04d14229e133\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"d9e92c76aea7d18c\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"eb0e59c9a1ad64d7\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"e25177a266bc25ca\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"449595b4d9e13e21\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"76a7a52d672bca9a\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"b7936b743a5385af\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"a16d076c6c58b3e2\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"d2f62110c54872e9\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"cfe94ddd0556ef3c\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"6e4d983004ee08a3\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"d03137ac7153af2e\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"8c3523e11a832cad\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"3bb1b294e8a94d21\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"492bed2dbfd9c8f1\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"8e555e150fab1f45\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"2726a2ae8ee62051\",\"/knowledge-medium/src/sync/transform.js\":\"a4950cda15e5ace7\",\"/knowledge-medium/src/themeBootDefaults.js\":\"4703a5f41a37ced4\",\"/knowledge-medium/src/types.js\":\"8db6f717fff9ecc0\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"0f9b529815f62943\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"694bc188021bcc79\",\"/knowledge-medium/src/utils/array.js\":\"46b38de104a28f2f\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"bf40942bf5aec419\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"5f990b251cb210e2\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"66fbeb5d92b4ffaf\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"61a9ee46ae25e5ab\",\"/knowledge-medium/src/utils/callbackSet.js\":\"e082e24f62ad50f5\",\"/knowledge-medium/src/utils/clientId.js\":\"53252aeb5f1a2c3c\",\"/knowledge-medium/src/utils/codemirror.js\":\"15a6a68e4eaf2d2e\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"7290a1777658216c\",\"/knowledge-medium/src/utils/copy.js\":\"85a76205138b9606\",\"/knowledge-medium/src/utils/dailyPage.js\":\"78205a9f6078795f\",\"/knowledge-medium/src/utils/dbForensics.js\":\"b5a34aa88a790cfc\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"9738cb63c6dec8e2\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"b012c431dada9351\",\"/knowledge-medium/src/utils/dialogs.js\":\"1ffb7109a0d9a8da\",\"/knowledge-medium/src/utils/dom.js\":\"fa3968dfb016283b\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"edb9d4254cdaa8fa\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"e4c04cb1742cc0f0\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"487778c4cd4989db\",\"/knowledge-medium/src/utils/flipSlide.js\":\"1fb018a8af7e5602\",\"/knowledge-medium/src/utils/fnv1a.js\":\"a8908d1c5ca9e402\",\"/knowledge-medium/src/utils/formatBytes.js\":\"b24ddf40a2f4df81\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"a4bf47358834d4a4\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"18df51d5b128f87a\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"2377b9f052de2464\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"b3da4ce7b50f7f37\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"1c5c408095aefb73\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"ea063850d57bf258\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"54a134d9a1123a08\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"e72732f83cd00788\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"03948c5a77b7def9\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"fd5be5da692bcd73\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"e62fc1412412677b\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"7ec3e9ac7a5bd4b2\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"d9077ec310aa5ca1\",\"/knowledge-medium/src/utils/markdownParser.js\":\"8313494a4bbdfa79\",\"/knowledge-medium/src/utils/memoize.js\":\"b5a2ad9e4eda1f04\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"e270f32e4a4b4b9d\",\"/knowledge-medium/src/utils/nameList.js\":\"236cd828e5a3e94e\",\"/knowledge-medium/src/utils/navigation.js\":\"29eeb8304a5ee31e\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"c56f5378e9cfa2b4\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"365be46c73de29db\",\"/knowledge-medium/src/utils/panelClearance.js\":\"9fbf3bf0c1b812fc\",\"/knowledge-medium/src/utils/panelHistory.js\":\"cd48386e9c0fb520\",\"/knowledge-medium/src/utils/panelLanes.js\":\"4ae3044f7e6b0971\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"2eddc2274b7f6f6c\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"2818ec99f06343c9\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"56f16670506f1f09\",\"/knowledge-medium/src/utils/platform.js\":\"cd9d1ec801712f0f\",\"/knowledge-medium/src/utils/pluralize.js\":\"9081dfa4a3c1e8de\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"3dc486d0628f88d6\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"e27ff5b860ec0d30\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"1a80bbe30ffaadc6\",\"/knowledge-medium/src/utils/react.js\":\"9a2c3c996782e719\",\"/knowledge-medium/src/utils/relativeDate.js\":\"d4d67231ce2040d3\",\"/knowledge-medium/src/utils/relativeTime.js\":\"3620514705919926\",\"/knowledge-medium/src/utils/renderScope.js\":\"0b9d069af1ebd62c\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"2e847fe3f30655d6\",\"/knowledge-medium/src/utils/routing.js\":\"f11cab312459272e\",\"/knowledge-medium/src/utils/safeMode.js\":\"5e38cc2c50cd2a0f\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"28f91e747d91508a\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"277f304871313624\",\"/knowledge-medium/src/utils/selection.js\":\"5d681ccc32ae7efe\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"6ad4c7ce70591666\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"142ddedfe94bbbca\",\"/knowledge-medium/src/utils/state.js\":\"6caa6a21d5687549\",\"/knowledge-medium/src/utils/string.js\":\"8306d53870d0dd67\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"4b00576891bf25a6\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"96861575eb1051e2\",\"/knowledge-medium/src/utils/toast.js\":\"ea3172acf2f20560\",\"/knowledge-medium/src/utils/toggleStore.js\":\"46859ba1af90d5a8\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"f2a832171779633a\",\"/knowledge-medium/src/utils/userActivity.js\":\"10ed9dd10bd3aaed\",\"/knowledge-medium/src/utils/viewTransition.js\":\"304fb7a606e0dd18\",\"/knowledge-medium/src/utils/viewport.js\":\"1b5158a2b61f3940\",\"/knowledge-medium/src/utils/webLock.js\":\"e4d6dafc151086d0\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"db94c5140df2dd97\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"b59b3b11df74594d\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"b3343cb1aa1bd82f\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"4b3b974bd7f5845e\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"6cef75740a88c7ac\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"9717c738ba8c7be3\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"14e8309574fbe3e0\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"7453447d8807646f\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"cc861f5b1a92a49c\",\"/knowledge-medium/src/vendor/react-dom.js\":\"ff5e1b17238e9df0\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"6a0dfc4910643eb2\",\"/knowledge-medium/src/vendor/react.js\":\"af1f98bbd0564f01\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
