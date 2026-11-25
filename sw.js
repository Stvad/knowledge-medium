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
		buildId: "d714ce379006-582ef939",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"cebbf7ab926d909e\",\"/knowledge-medium/index.html\":\"cebbf7ab926d909e\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"4158d0feb5da5128\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-BPY1Fb_Z.js\":\"947be7314f250dc0\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"3088d7f7d7ea2a20\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-DwsVmb6o.js\":\"1575821d037946bb\",\"/knowledge-medium/chunks/FacadeVFS-Dy-2Fe1u.js\":\"e4cd96bfd334ff8a\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-Cg_0RWuK.js\":\"cfa86282468035c0\",\"/knowledge-medium/chunks/MemoryVFS-DzFoVeCU.js\":\"f370271973b79c50\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-BGYB9SM-.js\":\"6005296d17e7fa23\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-CcGFYSjP.js\":\"619648197a897606\",\"/knowledge-medium/chunks/Preview-D9LaPM2e.js\":\"953aa6106379f0c4\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-BHvL1-QI.js\":\"35a7c5fa9908fe17\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-nyKwWlO-.js\":\"6e7bacf3061705f6\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-BK_gUp5n.js\":\"89d9cff8b67a3aca\",\"/knowledge-medium/chunks/react-C-lo8411.js\":\"dff78a171db6298a\",\"/knowledge-medium/chunks/react-CHhWSJxi.js\":\"f055361c39b5bb14\",\"/knowledge-medium/chunks/react-CoZ-ADpA.js\":\"2f5cab5ca246709d\",\"/knowledge-medium/chunks/react-D0Nj6Duk.js\":\"dc44a1c64025adb6\",\"/knowledge-medium/chunks/react-DEd3R0M3.js\":\"80b199cf5673e1a0\",\"/knowledge-medium/chunks/react-DO7z8CX6.js\":\"8b1472a8f712421c\",\"/knowledge-medium/chunks/react-DndUmFm-.js\":\"b5201aa563a181e2\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-CQPvcf9j.js\":\"6717cadb4a894be0\",\"/knowledge-medium/chunks/react-dom-server.browser.production-DHxTSgRP.js\":\"c5eaafa6a113cbb1\",\"/knowledge-medium/chunks/react-dom-server.edge.production-CoVmBZL-.js\":\"c85f2bf6e4534f6c\",\"/knowledge-medium/chunks/server.browser-YdY7eCSF.js\":\"608680f212a90954\",\"/knowledge-medium/chunks/textarea-C_Cowd0f.js\":\"09c375267aa07d9f\",\"/knowledge-medium/chunks/ui-DkjGX8xw.js\":\"e995441c5f0735ad\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"d939c4575e1c3411\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"7a24bbc4517d1325\",\"/knowledge-medium/src/appUpdate.js\":\"82f14b973276106f\",\"/knowledge-medium/src/appVersion.js\":\"48934afb4c8bd901\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"c3fe43ee30364f6a\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"820271a585ecc591\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"a7f198a6c313b349\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"6e03d7a8ff0366f1\",\"/knowledge-medium/src/components/BlockComponent.js\":\"6c5509933c654563\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"8db3d3e4bd9a3a86\",\"/knowledge-medium/src/components/BlockEditor.js\":\"69938fc944b7f22f\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"4a070424ef360352\",\"/knowledge-medium/src/components/BlockProperties.js\":\"a5b5b2712d194f25\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"ede742b783c18923\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"1f29dbd16df9abfa\",\"/knowledge-medium/src/components/DividerHandle.js\":\"da70809ada128045\",\"/knowledge-medium/src/components/DraftEditor.js\":\"0769e1bfc2ea6fd7\",\"/knowledge-medium/src/components/GutterPill.js\":\"49a1d8e8f9f874c8\",\"/knowledge-medium/src/components/Header.js\":\"baccb4dc6cc9ad31\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"260858fd00d33651\",\"/knowledge-medium/src/components/Login.js\":\"74e2ce8ed0e85cb5\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"dbe863c7baac438e\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"b3fe275d33a94f32\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"9df461141932a41f\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"25cc15f679b1b44e\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"064594967164df60\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"6f14d2151419780f\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"31b345615db8edda\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"c273f20942b1f4ac\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"017318937b9f7552\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"7d28e7ef2993859f\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"4e0905400998c7b7\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"b0219b0b1305f457\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"976e544812ed4c95\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"cb3d8b48411c02e9\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"fd1e79f942e442a0\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"2953a69d319076bc\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"e3e907f1d3f9807a\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"dcaed88ec84f39ca\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"093aa74da1e3a0b4\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"a06b51611f3510b7\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"8f5c72bd8d7508f8\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"006071a696aeee40\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"77829c0a7f4ca097\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"4fddb7d3dab495b7\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"bbd8194f753e5b80\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"9c30165965baedc6\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"737b4141db3596d7\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"1e8e7793020e872e\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"c114f8191f2008ec\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"deb5ef23e4df57c9\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"6225159f011568b1\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"804dc3f18fca9c55\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"e84e1d6eaa825bef\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"9715bda613bbed55\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"04d0c0c6f5a4576d\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"b8bf3371c894d2f1\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"1f51994aa47909fd\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"26c2e85b8cccf2d8\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"9034b9225aeef475\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"fc4080b1d0c37c39\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"3796d0b198b24931\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"6899abd95126f1f9\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"7f3e2942a3e62b1d\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"9aad4ff27f502f40\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"38b51f93a03f1c4d\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"ed41d859d88bdaf6\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"33659482ce53c6c5\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"6b1929a098177723\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"e9f496f93ed20fbb\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"cafca179c5cc7a27\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"a399c271b47de320\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"a7386a635226e74e\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"96f689a35c89b2a0\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"cc6e0b51200e7aba\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"61fb458c59a8f7f0\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"48aa0e0e021de094\",\"/knowledge-medium/src/components/ui/button.js\":\"2214ba79f20fd09e\",\"/knowledge-medium/src/components/ui/card.js\":\"f72dd2f07a3e4910\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"656fdf628ed1518b\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"59141236193bb057\",\"/knowledge-medium/src/components/ui/command.js\":\"f3693bfbccabfd82\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"7c3841ee49824e99\",\"/knowledge-medium/src/components/ui/dialog.js\":\"6630a9b76a427765\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"bae32b900fed75f0\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"f48f493ae615233e\",\"/knowledge-medium/src/components/ui/index.js\":\"ae5a7d605084b8b6\",\"/knowledge-medium/src/components/ui/input.js\":\"f211ed4cecc5b270\",\"/knowledge-medium/src/components/ui/kbd.js\":\"50beb96f3b10ebbb\",\"/knowledge-medium/src/components/ui/label.js\":\"10c5807ba342ae5a\",\"/knowledge-medium/src/components/ui/textarea.js\":\"671349d8a16e5963\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"ddddfaf6e9ce516f\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"9f0bde9323496e49\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"1cf08049a99fb7c7\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"1242bafdb1bee061\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"7a7c4260911f6ba8\",\"/knowledge-medium/src/components/util/error.js\":\"52c9ce087af16a8a\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"723d4f16d372d367\",\"/knowledge-medium/src/components/util/suspense.js\":\"c6786cf7ebfa97a4\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"912fb0757443e61b\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"fd4f08b51df34085\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"f217b3d4beedb722\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"5e583d39f9432ebc\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"4345cc5706f09ae6\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"e06594b8506ae481\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"a1195c748b40cb0b\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"be643e6339bf0094\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"18c1da720e86a087\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"ce28dd7193078ebf\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"f1c2fb9ed5b685fe\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"8c9fbf20b14b3b42\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"1b01171cd04d2769\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"db619e80139d6131\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"8e060f5211f93eee\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"4601301219dc30d0\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"d41459832ea8fcd6\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"c5e5271582f701a6\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"0b5bdc7fd22a1a07\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"cf9b185f25e044d1\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"947f727059793f3c\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"0ec8f38378369368\",\"/knowledge-medium/src/context/block.js\":\"a1fa8355a9fc906f\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"128f8492390da16c\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"ab5a4235d8b0ddde\",\"/knowledge-medium/src/context/repo.js\":\"17f540e2cf68e9dc\",\"/knowledge-medium/src/data/aliasClaim.js\":\"876d5acd0c88dcec\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"700eb3b6326f5ee5\",\"/knowledge-medium/src/data/api/blockData.js\":\"fffce0e0f77bae50\",\"/knowledge-medium/src/data/api/blockType.js\":\"da9b96bb8a8ae7ab\",\"/knowledge-medium/src/data/api/changeScope.js\":\"b6bb61de25dd4239\",\"/knowledge-medium/src/data/api/codecs.js\":\"c9bcbc3c7c779746\",\"/knowledge-medium/src/data/api/derivedData.js\":\"8710495453846e29\",\"/knowledge-medium/src/data/api/errors.js\":\"2438843b64bd2427\",\"/knowledge-medium/src/data/api/events.js\":\"a1f539566c14e806\",\"/knowledge-medium/src/data/api/handle.js\":\"96812971d4bfae4f\",\"/knowledge-medium/src/data/api/index.js\":\"e84788cf90bf5db5\",\"/knowledge-medium/src/data/api/mutator.js\":\"cb7b6b274147b9ea\",\"/knowledge-medium/src/data/api/processor.js\":\"6c76d1588dd4a765\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"68540ec65e913eb0\",\"/knowledge-medium/src/data/api/query.js\":\"5a60f4efa4883fd3\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"3632c90e065a0a08\",\"/knowledge-medium/src/data/api/schema.js\":\"96812971d4bfae4f\",\"/knowledge-medium/src/data/api/tx.js\":\"96812971d4bfae4f\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"797fddc1f7cf21cc\",\"/knowledge-medium/src/data/api/user.js\":\"2afd35cce74485a1\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"f8375340061116b7\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"3d29c29be1014cb5\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"9f853b6a9e2eed66\",\"/knowledge-medium/src/data/block.js\":\"e5491cdcb2eaefae\",\"/knowledge-medium/src/data/blockCache.js\":\"e8954b339c1e2fbf\",\"/knowledge-medium/src/data/blockId.js\":\"d203daac863ebf96\",\"/knowledge-medium/src/data/blockLiveness.js\":\"edf17efec13e0d54\",\"/knowledge-medium/src/data/blockMerge.js\":\"fcb518eee4002f4d\",\"/knowledge-medium/src/data/blockSchema.js\":\"9efe50a77381763e\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"9c91aaccbab1e562\",\"/knowledge-medium/src/data/blockTypes.js\":\"6c3f862a858b47c8\",\"/knowledge-medium/src/data/childrenView.js\":\"dfe6c13bfbdc4521\",\"/knowledge-medium/src/data/clientContext.js\":\"010881bc7baf2507\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"f9e983bfa22acb54\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"2a5bfb35113f9c0c\",\"/knowledge-medium/src/data/derivedIds.js\":\"1d11b57822bbcc24\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"98cd6664041bdd7a\",\"/knowledge-medium/src/data/facetBridge.js\":\"0a0f73eccd347a38\",\"/knowledge-medium/src/data/facets.js\":\"43d7f1ea4decaf90\",\"/knowledge-medium/src/data/globalState.js\":\"55c9f2db77b81eab\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"bf636bdd0c0b7c0b\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"cf671e668e29f495\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"e26531adae5f4d02\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"db1937c3d5d45fea\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"0574465ae39db5d2\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"d8ba07d0b3e84c67\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"db94a3f3331826e9\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"fcf98d7d55e2bde3\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"a9e896abea08bda6\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"b9bb626f8256f978\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"98328805b2aa480d\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"f84ce23dab40ba6e\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"d5f1c5b5802b5bf3\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"cd021635eabf3001\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"94054776df02dd0f\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"3308b944506708d8\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"b1a58a00d47018f0\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"569c47c903f069eb\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"08fdd2f8e6d41508\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"ebdeaa2ec57070b0\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"104dc9b2cc53a619\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"6b792faf7e8bf393\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"a0b47f0073fb89c5\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"c23e53dd3bbb2f36\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"387ce0fdc755ce7c\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"3e2cf7a12447f90f\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"9308ee2cef8bb930\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"fd5db4ae8ee1ffdb\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"93314c083bd8f950\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"431370c40ead5a5b\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"5846f9f689274ee7\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"fd31f0641d1375ce\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"36fdfde9a92cf59e\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"ef4935c017578032\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"516b1c9db1514f4f\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"2149a11993d7ece8\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"0db5933f56e1381c\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"f164031575e94172\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"a37171e0945d19fe\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"d14022aaa4d53e37\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"29d46030583ec433\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"4d5c66a4dacb374b\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"743dcead6b2ac027\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"ef1fe9ec518da98e\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"dda42510d997e64f\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"ab532e9236c674c9\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"4c469bc7aff6e3c9\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"25dfa4057c1f0439\",\"/knowledge-medium/src/data/invalidation.js\":\"d9f39c75e796b31e\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"18751b4ff3d97050\",\"/knowledge-medium/src/data/kernelPage.js\":\"6f540ae2ba676bda\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"68185c631b568528\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"ac7a9914a9fc767e\",\"/knowledge-medium/src/data/localDbStorage.js\":\"ac74e7cd0b6a4bae\",\"/knowledge-medium/src/data/localDbVfs.js\":\"0991baade72aef9b\",\"/knowledge-medium/src/data/localSchema.js\":\"a486b8e5dece3acc\",\"/knowledge-medium/src/data/maintenance.js\":\"e8fa19d6bc2b5fc8\",\"/knowledge-medium/src/data/mergeProperties.js\":\"8dd20ccc2244909f\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"cc945785906cb945\",\"/knowledge-medium/src/data/migrationsPage.js\":\"6566ca687647784c\",\"/knowledge-medium/src/data/mutators.js\":\"76848fc1e74825ed\",\"/knowledge-medium/src/data/orderKey.js\":\"0c5876eae5471232\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"b9fc259aea92dca9\",\"/knowledge-medium/src/data/outlineSurface.js\":\"b3eaabb76ba65c14\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"a57e2a814cc9f852\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"d680d3f1ccc6f278\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"a8137534cfb80f91\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"68be4753720285ae\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"ed14c0d57587a0b9\",\"/knowledge-medium/src/data/properties.js\":\"a2a26cba439d3cc2\",\"/knowledge-medium/src/data/propertiesPage.js\":\"f75fafa89cf40a25\",\"/knowledge-medium/src/data/propertyChildren.js\":\"3c6109b0ecc71253\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"3b0bf0721721e8a0\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"b95dacb470d41e63\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"1c8a2df496dfea36\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"ccb3c7d9d80eddd1\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"f34c6a70142067ae\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"606dc616fbdeeb7d\",\"/knowledge-medium/src/data/propertySeeds.js\":\"31dcd1ade6bdff51\",\"/knowledge-medium/src/data/recentsPage.js\":\"0194a9e8e67fe918\",\"/knowledge-medium/src/data/refTargetComparableProperty.js\":\"03bd1064f6423abe\",\"/knowledge-medium/src/data/referenceBlock.js\":\"34b0522306e5ec35\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"5bfac5379be88d6e\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"d9413f400fce9961\",\"/knowledge-medium/src/data/repo.js\":\"23cd41585da8c89c\",\"/knowledge-medium/src/data/repoProvider.js\":\"739bdbae22737645\",\"/knowledge-medium/src/data/rowProperty.js\":\"f23160f7ef038361\",\"/knowledge-medium/src/data/searchFilter.js\":\"04051e987c69fa19\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"84554ed1069004e8\",\"/knowledge-medium/src/data/stateBlocks.js\":\"6a26ca5f1c6238cc\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"49a1826432890b53\",\"/knowledge-medium/src/data/structuralInsert.js\":\"09dd642ef5e639b3\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"f722308950b61399\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"af5a35fb8b500300\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"054489edcdf66270\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"6b56a036752f80dc\",\"/knowledge-medium/src/data/targets.js\":\"beeb1a0fb1252bdc\",\"/knowledge-medium/src/data/typeColors.js\":\"16200216b7ab022f\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"4caa66a63b3948c4\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"c99348f38f99dc29\",\"/knowledge-medium/src/data/typeExtraction.js\":\"9f6e41ba34c09b93\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"aed5666b65639c81\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"0c0a7b2105e601b8\",\"/knowledge-medium/src/data/typeSeeds.js\":\"587a11557ea87f2e\",\"/knowledge-medium/src/data/typeTagger.js\":\"0293c83179b21752\",\"/knowledge-medium/src/data/typedRecords.js\":\"d4e33406eb2257e1\",\"/knowledge-medium/src/data/typesPage.js\":\"e501a4690712c76d\",\"/knowledge-medium/src/data/userPrefs.js\":\"99ffd64952898bc1\",\"/knowledge-medium/src/data/userSchemasService.js\":\"c27c37aba9e7be55\",\"/knowledge-medium/src/data/userTypesService.js\":\"4b347c255ef826b6\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"ef4e74352ccf9054\",\"/knowledge-medium/src/data/visibleChildren.js\":\"c156afa9e9330d1e\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"1e95d6777815768b\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"bc5da7408a8aa97f\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"61e1c0c757136145\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"c2e34a348c6b46a8\",\"/knowledge-medium/src/data/workspaces.js\":\"0a9a2bdf3a048165\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"d519f7f695fb9fc5\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"1323947b6aa4773b\",\"/knowledge-medium/src/editor/atTrigger.js\":\"3332178230cd672b\",\"/knowledge-medium/src/editor/autocomplete.js\":\"66a2e73b680d0432\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"df371b0e42b3d4eb\",\"/knowledge-medium/src/editor/contentFlush.js\":\"3eea905d6040204e\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"add218cc78e274c9\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"54c6bd2b26d53b6f\",\"/knowledge-medium/src/editor/insertImage.js\":\"29c539bbbb1dc5ae\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"2d957b4496f2a931\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"3914bf032547201c\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"8a5a1cbeeed74c57\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"4462aac6f236d259\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"7d092e46d072760f\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"c79bafe72134d8ff\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"fc9dbbd22a41a985\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"2b0c818f068449e0\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"733de3c5ebc292e4\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"5d732a934e964841\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"43b35d07fa3a970c\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"9d105ab1ce62ce10\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"b78f70799f267514\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"9cc15c1846e94830\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"52ca4c3838dd2fa6\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"ed62b0425d6c3110\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"b45292955b204d84\",\"/knowledge-medium/src/extensions/core.js\":\"0b1cc744d0fb58f1\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"c5e1f484347b872c\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"4541948aac3ea299\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"68aa5ae4af9e37a9\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"8fa345e9aa5137d8\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"3c8f577a46edcac9\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"ca4a0f45d309759f\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"21c7a2cb5aa03684\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"d15ff8d0b9e663fd\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"d13f2c22f8616294\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"836727df54479c6e\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"54fca01df669a6a3\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"3ef7cdac07858992\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"cba4720fc6fbf976\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"5bcaae3642b82d41\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"e28655f31b874c11\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"33b828bf5c7ae506\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"c2d8849773bfb951\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"f97802039b629f4c\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"b162f3a6dd97778c\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"0fad85c68bd2f134\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"0f9cdd24992bc2bd\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"c65f98c57a03ba9b\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"1cb72432bad7b2a0\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"8ef85b7330ab2c36\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"b266b618659d67f0\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"d31117631ee209db\",\"/knowledge-medium/src/facets/facet.js\":\"57c4f7846a801913\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"c66dd8cb1fd8ecac\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"1efcbaa39564f1ae\",\"/knowledge-medium/src/facets/togglable.js\":\"0695a49c0f414c96\",\"/knowledge-medium/src/facets/variantFacet.js\":\"90e0387c8ef38e95\",\"/knowledge-medium/src/facets/verbFacet.js\":\"ffd835cebdfc2efe\",\"/knowledge-medium/src/hooks/block.js\":\"98501ee23b4f3473\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"f29bbddf12349f33\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"7ee3352a5fc96c29\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"1277777e474bcab8\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"8869de1e8e4915c6\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"6cc27ae65b8ed8a1\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"c0f1850e5c36f3f5\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"ff347019aa2456bf\",\"/knowledge-medium/src/hooks/useFacetValue.js\":\"19d9faaac8e11b99\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"608eb33c55d7d381\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"ebe8c498a0a84de7\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"54046790850154db\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"50b4bdd0beb74c0f\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"cf72f8afe947137e\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"c0cc7c4d0282dde7\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"f883ff94b73946db\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"f6ff7562cb379b08\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"8851ea4496b6ab30\",\"/knowledge-medium/src/lib/utils.js\":\"cdf0f77595b7460f\",\"/knowledge-medium/src/main.js\":\"fb70ab2ca9825e65\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"cd13adde3b412a7a\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"7b92212f72655398\",\"/knowledge-medium/src/markdown/context.js\":\"b60570d5d9e64803\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"9c57713b096c313c\",\"/knowledge-medium/src/markdown/extensions.js\":\"97abda799aa2898b\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"60a4f81694837c74\",\"/knowledge-medium/src/minimal-editor.js\":\"196c6adad39736ca\",\"/knowledge-medium/src/paste/armedCut.js\":\"65a7e2202fd66551\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"0dde4e7d96dbbe1c\",\"/knowledge-medium/src/paste/clipboard.js\":\"f4ff2eb8984082c9\",\"/knowledge-medium/src/paste/decision.js\":\"59864c2c0de49dbf\",\"/knowledge-medium/src/paste/operations.js\":\"8c61ec4960cb3e40\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"ad3fd78e46bfeb97\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"fc55824ce81dd4bd\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"9a320455358ffcaf\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"c6af258b63d6b2cd\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"3c995e8505dd6146\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"7ed854acc228ae5b\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"77c7b1fb40829e76\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"bf1d84431db68e81\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"4f1f2b8986e9cf6b\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"6e307f835d7ff674\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"00fcdf9af89d0317\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"63cdba1613c63200\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"10b3669cd0034918\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"b60c176d02cca706\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"4fa1fda1cf80fe67\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"43561458153ca349\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"debcc5e163dca612\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"57df0c7d1a12afdc\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"7f7200b178f58fb6\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"914ce93f49d12e9a\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"f95486f26acb5c83\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"3850ce5b4d812932\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"16f9ba5ae827d2af\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"824df935f7ce9e97\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"d3cb26648986ba93\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"f7ba52129d16600e\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"10ff25ad7093a7e8\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"fd4988110c30947d\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"366876d2714d011e\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"481a81ace9c7756c\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"e0e9b75d9f82d466\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"15e9b75f3fdf3f54\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"2a93a917756e4c0b\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"37f737e88f92bde5\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"f5291e1bb400833e\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"c2b15a26dd054ec6\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"212a5ba9953ad06a\",\"/knowledge-medium/src/plugins/agent-runtime/dayPropertyInputs.js\":\"70558b4bf1bc2a6f\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"67362e5d83550773\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"de85bc19b2d8dada\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"01a53171ec7f4632\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"55c1795b507e6a1a\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"61862225e7d50af2\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"6c2dda17fbfa9b3c\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"d7ded88e8617abff\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"704a09c937079fef\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"fabc59df96eff120\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"6e30dccadf0029d0\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"fc72eb2a4bb3f5d2\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"790d116d2eb4934c\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"64b41caa61d7cbb9\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"a65a81805ab008ca\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"b7964f5341a57476\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"bc554fdb5aa6a7ff\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"4b30ee7c34f48fdb\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"446dcc5f88c2b98e\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"58131709d573924d\",\"/knowledge-medium/src/plugins/alias/index.js\":\"2e16ed25ed72b146\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"c9dd0a885c7b7241\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"e15fad55a6a6e0a6\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"4b76eeab2f8a920c\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"2de13c34c94b9154\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"3ae5fb087f776c71\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"53cc20c321ed0b4a\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"59a490564d951b68\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"fddc81e331a36773\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"26c05e233c3931e1\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"19c3bf1c71f6a86a\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"e8cf2775cc978c8c\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"a37a43683f5a8da7\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"6ee636c29278258a\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"a08ce18e42e9db1f\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"703faba5a2a5291f\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"6e50c1233657c9fd\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"df54d8fb16c8aa51\",\"/knowledge-medium/src/plugins/annotations/marginAnchorLinks.js\":\"60b9d6b5509c54b0\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"d96ba9b939d87e08\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"490466064003f75d\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"afabc9a220453de3\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"5a814a9f98fd8ec0\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"4b83e0f61b0f4628\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"9ede53afc790a5ec\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"5918fb9f3cdccd3d\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"d410db8999ecb8fb\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"8b9e3c5bf596069e\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"d8294615bbd2c9b2\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"24e030251dd336b2\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"01d270d4ab631732\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"d23cfdc341076a77\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"3908e52f80878fc6\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"b284f488b3031930\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"ea858795155d300b\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"52a13c8cacd2e057\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"11ca73f98da70474\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"6dac49094d2521c4\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"05c7daf3f8018117\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"aa94f574b4acab1d\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"0003ed0bf2f86dd6\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"7ecf3a28fc005b69\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"9f1f04826a77d77c\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"92c2cacc64dc9a7b\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"ce06baf37895e112\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"b9c51215bcaed277\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"a2fcb49b1eef9238\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"5f2d52b202a59fd1\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"d09d9091f3322a5b\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"5ff1110c0afad100\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"0f656d5bf34eaed9\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"5ca487a8e1ea8602\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"d66391d6f33f470c\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"a156111550995075\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"038f3d9400a2c8f8\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"986bc0ce6da1a15c\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"467dc1b4b696bc00\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"2600b74fc039c8ea\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"9ef378cf9a074194\",\"/knowledge-medium/src/plugins/attachments/browserMedia.js\":\"fcd629e2e772506a\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"b130908a18d9a966\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"f5481cc14ee5d7fc\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"3436925434b79ce4\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"32c0e6aa239252ad\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"1f9577b1a4fa1cfc\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"c4dff0ec50ac3444\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"7fb37ff3fc1f49ba\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"98759b7868eaef95\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"5093339b00d8e568\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"44fce49212e72d29\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"01b889ae09c16654\",\"/knowledge-medium/src/plugins/attachments/mediaLanes.js\":\"d28b161cc8bf179d\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"09f728cb0bc18124\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"e937a2c4dc9760cb\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"e7f5c08248fcc366\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"ee573f40a3fac577\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"da4d693d9cde2e3d\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"fdb8234426c359a6\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"ae724601475d5947\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"20cd25842a2319d2\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"7f22441530dff51e\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"09d94c5de46baf5f\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"283d87d8dffed4bb\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"c9ce5d3a2ac607d1\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"70cf2941b4a67120\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"7933cb715e751739\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"8b78581cff4ca738\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"19ee26de735c8096\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"b7da2db3d10dc07f\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"221e6bb0efdebc86\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"2b7de6bd81881621\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"2ccedbdd14e7f33b\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"44a8d6887fa2a60a\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"5bd2f0326693c68d\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"d3a46899ec1704a1\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"1795360ff56a3626\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"b8f304f73f2ebc30\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"55323099b67d09e7\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"978b50cdf826e1b7\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"87bf283328ccd1ce\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"e3da3a107fbb2b64\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"627b3f6372af4573\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"25d26417b78c5213\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"4cf7413604b216ac\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"295ec5b29c58a1d3\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"9df6bfde924d1cbd\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"9584bf9131cb69a9\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"94bffc4537fc95a2\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"839613dd9b86408d\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"0b811623b4973fb9\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"6b0a579630ae4cb7\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"ae0ac876a34cba64\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"ade536914c5ae857\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"7363605fa0a3c218\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"0ff08e6be2606c17\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"806fdda956a6bdbe\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"a03cad2ca9d1dea7\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"b099797649e7c268\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"58ab06ecdecd5237\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"f5d8789657f7493f\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"d42be0170e8e7b50\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"75e560bc7fc256bf\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"0f86bd3db47bfc20\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"01a05032f825d291\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"8c44164ada2da8fd\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"2d7652592c804fa3\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"5a7fa9a2ba1023ec\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"d22ca9cd6d9bb2bb\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"eeb9386260891095\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"a10cd7b3f61fb405\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"3fe699f205ca40de\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"95eb4548c264adf3\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"c2a6cdb7e47cfbc6\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"34ccf52cc631581d\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"14469c8a8b863be4\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"7b4b984153b0934d\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"b2905b4ea61381f4\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"c5dabf20e1f3cd90\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"3cf91ccbb8f3b2f1\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"e03aa0f0160b2d3b\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"338fdaedc8cf430c\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"d32220aad9875a64\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"d0876d2f30691b88\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"1c99a75a561f522b\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"e39413eb9dca8ebd\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"25b015f273722107\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"4387c91dd2dbd394\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"a4ee1ad28f9a7206\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"d021dd975296d409\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"727819adb2cac04a\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"77148e16f7253299\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"791cc56cc61606f7\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"e610e805f565dc2f\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"855e490986c5d0d7\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"671efe2a3258d261\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"4c17bb373054e4d2\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"bd51889f5cc3bcdf\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"120658cb5fe79f0d\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"a87b889ee12a7cf2\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"f95c2b4b8925fe66\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"3f16400749ac587d\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"108f522af4e59dcf\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"6e22dd584648fc37\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"f610200b87c4b4c0\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"4bb2a2e9bbacd226\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"0cebd69cdd5b2d50\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"9c979198c1efd95f\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"535096c7c0254bb5\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"89e6d0f8d7c55d83\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"63bfbc21468e552e\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"79744707346f2329\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"b4998184cba9af4e\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"309dd4b40db3e102\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"d6c403de9609942c\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"9fa496089613d3ea\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"02b341a046a4f84a\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"f8346edb83c2afd5\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"04f299e9aa0924bc\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"aaea5cb6861c863d\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"5311b3b9544ed694\",\"/knowledge-medium/src/plugins/daily-notes/DayPropertyEditor.js\":\"17b9d3b67a01ff55\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"b75c33bef9f6e6f0\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"de8ec3424a4e136c\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"1bc3c8784c1e3646\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"abec7ae6affcb8f1\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"8b49244511fceae9\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"3c60e70a40d1ad3b\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"c891301fa431e665\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"a6e3cd96d2cf2be0\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"8bc7822cf285a58c\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"23c90ca59c6a9d50\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"593fd2f0c012d9bc\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"685995aa73d13aa9\",\"/knowledge-medium/src/plugins/daily-notes/dayProperty.js\":\"ad19514fda10e26e\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"520157bd70804ef0\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"10021262d0a0b92b\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"4bf2f52dbeb5bef8\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"a02e34babff95a9e\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"3be61c64d7c27cd0\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"1915e26c4a25379d\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"ec57c5c58b990256\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"8fea86251ae36bb7\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"46ef9392675ec315\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"61c899f279e1f477\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"4756707e3ca29392\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"54f2934680b416d6\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"51b4ddfc97da3699\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"33e2f6482240ad6b\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"9848151d67df6135\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"bced7d87b11eb892\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"321acbf7cef09794\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"7373d89d3e561bf0\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"60c7534db4da9edc\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"f48a49ebf7bb4930\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"2ed8900fb51f7829\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"44186230de35afb1\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"def2084f7c0b9a89\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"be7c17934678c8ee\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"fc5ad6e4d92b6012\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"0da48ffae49a8c12\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"03a10e12c94cef30\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"acef4324fbf9af31\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"a94ba2eaec69c9f5\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"fd424fd5f9d72200\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"22254d5eab35a7bd\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"ad9283f943cd7d40\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"db1df0aed51c2180\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"b95bdd1998271963\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"62d8cf1ab2302cb2\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"251a9e6668f70d82\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"387243105dc9101c\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"7a39f7d849cd2e69\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"d208fe05951d6124\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"773302c1061672c4\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"cfc9a3678f5ed5b5\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"dd8b59493290a663\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"79cd019151e6a431\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"05e70b3d8566237d\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"3be2ab3f6a64a94e\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"449b2bcf5c1ac959\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"d7d4d619e54deaab\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"893e6ccd98eb9183\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"6d87e0a405ec18d2\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"2e7869dd5b85e19d\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"5c4051cb03149e8d\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"a5d6e2edbb8bc367\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"96d39d090fb8b307\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"19484fb29b661f65\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"5cad326460a4cc21\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"e2d4f7aa8376d579\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"2f5d7bd22fc8e216\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"78474e3542048eaa\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"57b85328c4bd1c75\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"b7557291072c5396\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"38c9c627386fbe85\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"0733bab8c8dd0cb7\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"82a00b5a06ab6836\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"b8add1dc09ac81d4\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"fcd2264015598e35\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"096406d2aac37d99\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"198142d1618e90b4\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"271e58e3bfb73637\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"3a124f5fbc893892\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"d80a8131469ed867\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"fa4644dbd4163414\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"6c8adbf6cf3babe8\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"0e8ca442b8665134\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"9d9422145be13679\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"8c0fe6df5ff79c12\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"3fb9e6a4087c6bce\",\"/knowledge-medium/src/plugins/geo/index.js\":\"a4fa7ebef13bf30a\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"c868dc640b2064c2\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"8c5cb49cea7cf4de\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"93d3b8e8018e9bd5\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"1fcb6be297fe27e2\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"a692e5e70098a032\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"a74fe7b81d41c515\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"d2825436eff8aa2f\",\"/knowledge-medium/src/plugins/geo/query.js\":\"b5961f3d546df09a\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"d462908d7603c30f\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"076f77ad9549ca0d\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"178e0ad461bb829c\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"8d1f4a2a4a547a61\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"1b4719fb0b4f78f6\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"34da63a0dfab8878\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"07de349f70b09778\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"1c954af03604a71c\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"d2a6f1faa954ef53\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"014eabcde159f910\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"4932f58a9600b3db\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"444216d85d944992\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"e41664dda2373f15\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"9084255f92919329\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"35291e5a3f75ce11\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"ddca2b3a09ab69d6\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"83c95c6e594ffb50\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"665e5c7093cb4a74\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"3abe11a0c7929df2\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"e8e6438ca036c156\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"0306114aa8ff4ccf\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"1d294bf2ea6a118b\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"ef532cec174a3d49\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"b08d328e7cde7d87\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"809a6109245a9fe1\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"f4d2ab90682f5533\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"205cb4127a6cea94\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"813d0bb67edd1942\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"5dffed35019eda85\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"8cc858bd3b9b793b\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"6801d1183ecf2f6a\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"9381ec883b06accc\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"19fcaa8769b7a30e\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"b7b566e9136e76c1\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"68f2a28036036bc4\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"067a8736072ee733\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"e2c80d9aff0e2f52\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"91c0b0fc94754a69\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"1322cb44685c6ffe\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"ae9767d4a21d023a\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"c8fb7f024c733c5f\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"950c6db42d3f3d7d\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"08e75b1f8cbcfcf6\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"1e24ef9b84cc777f\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"4a2e7e1ef2919beb\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"97ad61260734ca6c\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"9b210afb2d3ffbb1\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"41091f031b6a0f0c\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"03c9d764cfadd579\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"8c0d61de5e1ad198\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"d46e81493e24f44a\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"3e03ea18584f3b79\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"b1c5e3f2689bd773\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"227c355b70915588\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"4f4cf4f7d1c633d0\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"d5a21b9eda65c399\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"212ae666f5e7538f\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"a033dbaad4538d3f\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"82eb54b615ee55d0\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"2edc435141091f23\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"f0013ea437d83d94\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"3ef4422d4aba7b6e\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"4070da09e948a9ae\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"ffa12cd0e3a069eb\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"43c67006dd24f579\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"5dc4acd8181c0cda\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"e02717ef7a36ae75\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"eb681e2185f59355\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"d0600d4d66a0db45\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"5b7b9c84025f7841\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"ee43f38482be5fae\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"c36cc50a1b5041a6\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"7f3afe969caa2d7b\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"9ed42290b380c29a\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"9271c07a5fbbf778\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"f4ae489d0d91ba96\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"e82adbc793d88e4e\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"0feb6078ca5ae8b3\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"f23d2c68e79d051b\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"e6bebe5a7c170e92\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"970f4914ce4ad052\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"7c2cb7248020748a\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"ce54a021e4067eca\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"101758cf6ab9031c\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"59f82a9bae85b003\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"1414b09bacde3b05\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"25376a98950355d9\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"4a90a93a630db2cb\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"b45484858619a00a\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"42e1d35a42f1bffa\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"39c4c403eff33c4b\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"308b02446e8d23d0\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"c1473104b5503ed0\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"45fcbc7f7cb353e2\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"78bce23dd4fd7dfa\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"1cd10a2dfa6b7b5e\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"886cd4d4a8075800\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"75dcbfd58b431470\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"2b8014105f754b9c\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"146a33a334e106ce\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"0dbf5a8369f6ab1e\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"7c78dad468a34e62\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"365c8a50170347a2\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"2f98a4e71d17c2d5\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"a6914396d3b8b2e8\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"e2c01398ca197010\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"daf7d3636fa35550\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"e6008bea1d8accfd\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"14da4fc504e30dc1\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"28807910aad78b7f\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"922618b2a6a37d5f\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"d6134da45a09fa06\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"cfd1a908faf63973\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"9c7e64d002744db2\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"d386f67e4db19c3b\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"f9e5a912c3295399\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"413fa69080472979\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"510c1738ea44f586\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"effc062cce7455af\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"592dc72f881ea447\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"76462d1831828691\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"77fcccaf0f595f9d\",\"/knowledge-medium/src/plugins/recents/index.js\":\"9179be555b62d3c9\",\"/knowledge-medium/src/plugins/recents/target.js\":\"a412e45e65cd52e5\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"c13a1f71e05b09e5\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"3938cc9667d7ae30\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"72c31cfc811e5a8f\",\"/knowledge-medium/src/plugins/references/index.js\":\"4a0a2108e3f094de\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"0600cb9b4257add3\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"6e11220c7c8b6e36\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"230714d8371a3a72\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"e1fcdfd7ea8cfd58\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"bc064356a03ea3a0\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"d04311c95fd3e213\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"e915cb57c29f286c\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"881ade27649e417f\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"6fbb2a87dd254660\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"12eefbf734be2fa8\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"5e546bfd880b1c48\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"0fc2200b5f83af24\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"910f32673cab5719\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"fcd0112833023296\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"127eeedaf6e74626\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"b114ed7bfd55bc5c\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"aa940c7ae0a557e9\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"c4bf5ad155ec89da\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"847574ce3b9f11d2\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"622e06600500533b\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"1a7fea192ab7a49b\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"889fdf731d359b01\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"791d5adfcf60d84b\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"a062502a69bece5c\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"5d513ea4b24bb381\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"ff83bda047cade68\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"425dd770b0fae2f8\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"b05cad5c5a23f59e\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"3bbb3adbad4fdfff\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"c07093abc1d32a5a\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"b946fd02eb3f0683\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"f99facb26c72c8b4\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"0e839d65f8ac7330\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"16c0d39a005dbb8f\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"cfee000f1ce93397\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"27b0e8fdddc08b8d\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"c300c0d6625de917\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"c8a773396eaa6bd2\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"318545fd52b01aa3\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"4e5979ed929465bb\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"ae7a1d9e61d0c55a\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"bc08a4d3ce89ddbd\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"a3db96f1039c47c2\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"9f0843812e86282c\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"ca0985386b8fbf36\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"1b52a0ea0f01c2e4\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"2a5427a37df4f9cc\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"9514fb66688e2d29\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"a892dbf7fca26764\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"a31e4cbe1b7527c2\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"edbc50735244280c\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"d37e257f26818c1f\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"a2af6072b937d954\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"069471bfc9140d98\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"2137123f155328b8\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"f99d5c36c042bf13\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"b70f886347d15858\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"2d9ab058cf85c621\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"f1461592817d8deb\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"bf6060c05e6b1297\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"1666d6872cd5a5c9\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"6e3bc81d892f654e\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"0108ae36f733402e\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"6719ceee8bb981a0\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"9a3b8d33b0806114\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"e4c8e90e0051fb09\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"b6f7995b5f9ede6c\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"2d0dda28883b8852\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"2a9063d63f8ee09e\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"004282f2b63865b7\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"7a58e041c21ea135\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"b5336178740c6ec2\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"2af01bd4a4813f38\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"347e3dbaac1aa92e\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"1bc4391020c422d3\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"1d115e78d8ebcc9f\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"79f9ca27e8f48390\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"b83afde204e7a0a7\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"5b0fd294b5d211fa\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"e1d6041b89f78b79\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"27dc11c552960cdb\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"cec22bc2e4ed159d\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"e8ff55928822a611\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"836a1f6db07be3dc\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"8267b2df3691084a\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"b0066874a8609515\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"859cbbcdc6410439\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"350c95df0efd502b\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"1ffa01123881967d\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"d11b2b4df5597b99\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"740a5e727de4ea13\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"8c9c025fe785aa7d\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"3f6fd0e97717928b\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"261331f255bced9d\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"4c6076ea7c54231d\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"e5c2ff6a40e985f7\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"34bb61ba055aa25f\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"f14e9bca7c8dd301\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"5ff725ce6f3e1d0c\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"c4b5be089a4b5607\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"04602377834268a0\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"e36b327e179626f0\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"acbc09422864c89d\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"5f3f510b97809673\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"6df2af91bf268352\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"051252a09d9106ac\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"cdf05a58cc48f9b5\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"be3b956898af844f\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"c11dc03d15e6f179\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"b0202cf467db89f5\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"df46359b02df0353\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"2fdcd40151267ea4\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"759bfe689f435cd8\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"99a0c4f0390fc9b8\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"b334d4629ee7bac3\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"7a4c09f07b12cd74\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"de463172e0cd1e35\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"ced6bffc3932b705\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"c4df23d1dd3b5654\",\"/knowledge-medium/src/plugins/tables/childrenViews.js\":\"e77ac3a17f118f23\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"9dcee60e1fb1a819\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"87125c13e5a3f6c3\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"d2a91bef23510e10\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"58324416cce98601\",\"/knowledge-medium/src/plugins/tables/index.js\":\"fdf4ed68a6fdbf42\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"b75b786c553754bc\",\"/knowledge-medium/src/plugins/tables/model.js\":\"e307c51e0e4ec965\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"8745c7e55dd903f6\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"158623b55b42cc9d\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"8a79b9d35f341fbc\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"f096cbf8176f995f\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"e1f80fcf3d506409\",\"/knowledge-medium/src/plugins/tables/query/registrations.js\":\"d35637b193e3367b\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"326dfc9f5b3d2eab\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"438fcde99b0f12c5\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"3ef96da6a80235a5\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"15578d3a3b49d3c0\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"5632283dad94bcd6\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"f90af77269c1c101\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"1bfa44d4b5e2fac7\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"2bce939891efeb01\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"d4b77e26448b2a45\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"367794d0218005c2\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"0f3d0de29da69100\",\"/knowledge-medium/src/plugins/todo/index.js\":\"6618510ac9ed1810\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"da7d9c8430653025\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"a05e220ffdf6702b\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"f8cb66b8902e9e66\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"5069a5854c5313ee\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"45a12f6db24512ef\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"f6cc473ec17636d7\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"5744b4b2cb07a1a8\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"3f724857b32abe14\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"9807e326a5ac8470\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"03dd35f33f1100c0\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"0baff937d264b235\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"edc657c786830e21\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"533442dc4db318e0\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"d55941033a24ad97\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"b95b7f4d2e242f43\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"fa612ce2a68f114b\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"b9782d3f2cc834a8\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"600905363a6adce6\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"80c3ab591026c637\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"92024115f3ab8596\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"fd1bb2f438fe314a\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"bc6785d428aa310c\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"f0f25e1edb4615c0\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"80744cf9a9f5c95e\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"1cfb7b2804dafde4\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"c891bc01968a8b0b\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"5b40fe3777a18348\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"bf34868240018c41\",\"/knowledge-medium/src/registerServiceWorker.js\":\"2fb880a0df2d5e34\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"77a1765aa1de926d\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"88a8b4daeb2245f1\",\"/knowledge-medium/src/services/authStorage.js\":\"9aad6b594669bf62\",\"/knowledge-medium/src/services/powersync.js\":\"88b1bfe0674dd35d\",\"/knowledge-medium/src/services/supabase.js\":\"946f5aea703ae8e6\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"9a35988f863c627e\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"1c8778f1a663deed\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"dd9cec6def6d1622\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"3bf955e6beefbf13\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"bd2a1e75d2efa319\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"59b952f303ef5903\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"cd0e9af8da00fbca\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"95a1ea4f9dbfbf32\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"db2879dd1fd4b8e4\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"1a83372747ff67e3\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"225b7000afe9dfb3\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"cc1d2a2d9ae31266\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"204279890190ad53\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"9e015e3666259157\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"54750a48e583ef8e\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"646fa0b818f190b5\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"7eaec7b26cb9717b\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"65069c1d987ea2a4\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"42dd4d9be8154bde\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"0d6563a047b204a4\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"7bc952c8933a363e\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"9b88b0b719ff03aa\",\"/knowledge-medium/src/shortcuts/types.js\":\"797f9d8188f3f6fe\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"316d84a4dbfe7e01\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"1a1e9d449d24ffcb\",\"/knowledge-medium/src/shortcuts/utils.js\":\"a45781cc02a9ae8c\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"09a08df53f38de01\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"3057dceeeb0f4ab5\",\"/knowledge-medium/src/sync/byteTransform.js\":\"0db5e9a5d3b79334\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"9c25ce1ee40d01a8\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"6551ed69b763e94d\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"c28e5135ed92cd7b\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"92b87f5708fd0443\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"531fc3651adb9ded\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"08102001e0d13e82\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"8c213d71848a6850\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"b78b2752a74758ef\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"3fbce6b54634792a\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"1e3fb5a14147c626\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"e9590c1ba991fa7e\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"178c131dd4a4ad23\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"cdbcf3d5e1a69ac7\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"2fb9e0c96a368bdd\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"12be15c3bee54c0c\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"4798875511c49189\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"59e22f411bd0db8e\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"c162e370871c1ed1\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"509d1a38150c497e\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"b76de8a4c4c51cb1\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"29a2c49ac61b0677\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"c43aa8c31fe351b3\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"147211c435e6d9a9\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"5202e715461dc9c0\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"dc235602c464c9a0\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"53747d688e73ae00\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"2e75252162f45ffe\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"1b28976cc29de598\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"3020e319c9d257f7\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"d99624b4a5aadf1b\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"d074ac83905a1c42\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"efbdf100aee9d445\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"7a31fad188ba1999\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"1f2b641738b0fe7f\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"6a8bfbbda93306b3\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"ea554f714fac2af6\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"cec3f5c216a9cd95\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"b24652a997b36004\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"730b8751d0f28b2d\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"81fd8464c0ec8c6d\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"0898d9a7268d75cb\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"70d1a379fc92e4de\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"9b40db42e1cc3221\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"5875b60fdb6fbe7b\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"0cf34bfcdd609ff6\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"37b47fc83aecb6c4\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"c0a2c87fc6a246a4\",\"/knowledge-medium/src/sync/transform.js\":\"4efdd459ff9a3ff0\",\"/knowledge-medium/src/themeBootDefaults.js\":\"b83ba1c84b517abb\",\"/knowledge-medium/src/types.js\":\"acb3f4f7bab5ef11\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"d3ff1feb9ac3c94a\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"c406c1caa87f8d9b\",\"/knowledge-medium/src/utils/array.js\":\"e3f2cbda3da20ac2\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"e438296fa663db87\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"2544030e67cd2e8e\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"4f12925abea3d4e6\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"e5ac9c339446fe48\",\"/knowledge-medium/src/utils/callbackSet.js\":\"fab1363c31fe1386\",\"/knowledge-medium/src/utils/clientId.js\":\"c62cb16d780b43e0\",\"/knowledge-medium/src/utils/codemirror.js\":\"4230c96d8210b85d\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"c209da244366927f\",\"/knowledge-medium/src/utils/copy.js\":\"2f41d29aeca7cb80\",\"/knowledge-medium/src/utils/dailyPage.js\":\"ac13461c688c02e6\",\"/knowledge-medium/src/utils/dbForensics.js\":\"0d86a0383e364c30\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"7697bee4bc45ace8\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"12f1f2e82fb48075\",\"/knowledge-medium/src/utils/dialogs.js\":\"7f952b6011b800f4\",\"/knowledge-medium/src/utils/dom.js\":\"19de4af64cdc011f\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"8f6c0240ab245fd3\",\"/knowledge-medium/src/utils/drawnWalk.js\":\"8fca419498db1e89\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"26d2bb6c2e1a9ec5\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"c3a390037a368959\",\"/knowledge-medium/src/utils/flipSlide.js\":\"2f48050d8e687b36\",\"/knowledge-medium/src/utils/fnv1a.js\":\"eae19e1204de77cb\",\"/knowledge-medium/src/utils/formatBytes.js\":\"ead95d335305481c\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"0e7461c796ca51c6\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"a239074d56e98c07\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"2fdcf45e0984483b\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"57accf2e5393b345\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"39fccadde30faff7\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"c69cd5af9bdfd461\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"47c0d80665bcdff5\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"cef1c0fe911d52cf\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"3d50aacf38abf9e0\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"6fe33b877b494cd8\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"21daf2a7e0085e21\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"d7e6882dfacc480d\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"c0da739fa5fd32f1\",\"/knowledge-medium/src/utils/markdownParser.js\":\"8356e381af0a0e01\",\"/knowledge-medium/src/utils/memoize.js\":\"837ce38d624bcf48\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"33a6b3bb189984eb\",\"/knowledge-medium/src/utils/nameList.js\":\"df299f74454b1869\",\"/knowledge-medium/src/utils/navigation.js\":\"25bac7979509754b\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"e6b199764da6fa89\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"ebf0959d2a079327\",\"/knowledge-medium/src/utils/panelClearance.js\":\"a805e3b85a98ebea\",\"/knowledge-medium/src/utils/panelHistory.js\":\"5f8b085d6f053fb3\",\"/knowledge-medium/src/utils/panelLanes.js\":\"165c3e321217f64e\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"ba958d423a1c86ae\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"dc70de1bedd3c390\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"9fc68d84f979d3dd\",\"/knowledge-medium/src/utils/platform.js\":\"3c95bb74891870bf\",\"/knowledge-medium/src/utils/pluralize.js\":\"b980716c337064c0\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"6df8a215c740bc75\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"74601dbb159a1fac\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"e1ee7571faea1b12\",\"/knowledge-medium/src/utils/react.js\":\"967880339f7b68f3\",\"/knowledge-medium/src/utils/relativeDate.js\":\"c4e38d48b95d45b6\",\"/knowledge-medium/src/utils/relativeTime.js\":\"adbc2d77fa821613\",\"/knowledge-medium/src/utils/renderScope.js\":\"0993eb54a91c9384\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"858cbc5711134369\",\"/knowledge-medium/src/utils/routing.js\":\"b09ca4eea27edcc3\",\"/knowledge-medium/src/utils/safeMode.js\":\"03618cf73337fe84\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"18fd1f666d8cb116\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"eac9d5e3699571fd\",\"/knowledge-medium/src/utils/selection.js\":\"b79c4c03f1f2de05\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"905578e40e5fe82d\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"4c80fb6c294d7b99\",\"/knowledge-medium/src/utils/state.js\":\"67952c9b83be857e\",\"/knowledge-medium/src/utils/string.js\":\"5742993d9794830f\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"4b05bb18643691b6\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"a9842006e1e6aee9\",\"/knowledge-medium/src/utils/toast.js\":\"e8b7eaac1a5c90dc\",\"/knowledge-medium/src/utils/toggleStore.js\":\"bcfc3386c14024cb\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"eab6a465afbb227b\",\"/knowledge-medium/src/utils/userActivity.js\":\"f2bb82f07fd28d5d\",\"/knowledge-medium/src/utils/viewTransition.js\":\"7fea83a4f18ccf23\",\"/knowledge-medium/src/utils/viewport.js\":\"fb501773fa386615\",\"/knowledge-medium/src/utils/webLock.js\":\"200c976c48b057b3\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"0a8ccd427564fb9f\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"0d583a3ce6eb3ae8\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"78fb2f9e69e3a7c4\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"055a00063efb9b16\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"1ed1e999ea63bc0a\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"257f8d90a8935184\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"62dc9ac64e3c015b\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"19af8c8c5c15922a\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"14354ba185925a98\",\"/knowledge-medium/src/vendor/react-dom.js\":\"64cc620cdd263938\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"9554835599741ff1\",\"/knowledge-medium/src/vendor/react.js\":\"c1174f7c4bef7861\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
