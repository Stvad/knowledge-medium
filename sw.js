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
		buildId: "57d42c0d3616-0963c244",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"56d7db7cb7f3ae5b\",\"/knowledge-medium/index.html\":\"56d7db7cb7f3ae5b\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"d6b85c2ba5dde3ba\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-CY2u5ZWT.js\":\"fe28fb27c466ed2a\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"29b7e690b1a43fe9\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-CB4pkGLj.js\":\"4eed562b2dd861f0\",\"/knowledge-medium/chunks/FacadeVFS-DcCHrig7.js\":\"9bf4e38b34770ea1\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-DZd_MEvF.js\":\"e821ed692ceaae74\",\"/knowledge-medium/chunks/MemoryVFS-DfBnzuOn.js\":\"f83d769cdf8c3506\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-CenVdWTi.js\":\"e65ba03f837cb652\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-Cxvi1JJ-.js\":\"e1021e8524f5df47\",\"/knowledge-medium/chunks/Preview-JudgD7I9.js\":\"50100cf377856320\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-jwBlwoYG.js\":\"ca4c1e0fb8c609a1\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BspeV6vg.js\":\"e1127c5c2e08320f\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-CkK_39t5.js\":\"00a66d3966af1bd3\",\"/knowledge-medium/chunks/react-CojSBhpP.js\":\"7f0ff2afb8f746b1\",\"/knowledge-medium/chunks/react-DGJkrVnX.js\":\"41064d7afcd02f7a\",\"/knowledge-medium/chunks/react-DwgC0jSC.js\":\"34b062c16374544a\",\"/knowledge-medium/chunks/react-PICPev05.js\":\"fc271b13e3b3a192\",\"/knowledge-medium/chunks/react-Upqk0cqw.js\":\"5a8f048cb1ae75aa\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-BJHTBkUC.js\":\"57b53e2be2f79dac\",\"/knowledge-medium/chunks/react-dom-server.browser.production-BAiFdjVf.js\":\"056f96f2c5a53ccd\",\"/knowledge-medium/chunks/react-dom-server.edge.production-BtmbHkYI.js\":\"3d9d791ad26f3da4\",\"/knowledge-medium/chunks/react-l4OIPI0S.js\":\"4fdb4b682c381e12\",\"/knowledge-medium/chunks/react-tA3kbgRV.js\":\"de0d70efd3a3c3e9\",\"/knowledge-medium/chunks/server.browser-Bq_YIgbI.js\":\"6ed1303de60d47e5\",\"/knowledge-medium/chunks/textarea-DUSffyw3.js\":\"17bd552bcfcae2e6\",\"/knowledge-medium/chunks/ui-iDeBXpyP.js\":\"73b0bba779361105\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"888df5881ba9f759\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"88daabae7e977c5d\",\"/knowledge-medium/src/appUpdate.js\":\"1b89882d24e48ab8\",\"/knowledge-medium/src/appVersion.js\":\"fdac5983d754ff2b\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"19e6823b78a58664\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"8be5ac92d8913a46\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"3827f032a6d710a9\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"aa7e5fd47960f3fc\",\"/knowledge-medium/src/components/BlockComponent.js\":\"0e754f44679c1a68\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"c4863cc18dccf937\",\"/knowledge-medium/src/components/BlockEditor.js\":\"0f4fdc60e879fcde\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"720b179964364d15\",\"/knowledge-medium/src/components/BlockProperties.js\":\"0836482e50ce2198\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"16bc34799f5ae4d4\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"5a4576be945cc22e\",\"/knowledge-medium/src/components/DividerHandle.js\":\"628089fcf50ba5c7\",\"/knowledge-medium/src/components/DraftEditor.js\":\"3882b793b310ada3\",\"/knowledge-medium/src/components/GutterPill.js\":\"f876e0a59d45c83c\",\"/knowledge-medium/src/components/Header.js\":\"11b87e428c861811\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"a4bdebf57a23accc\",\"/knowledge-medium/src/components/Login.js\":\"59c66040e5ac9855\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"a71fa858c0b7c987\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"1e36113bb714a766\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"6be929b2c0353aaf\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"f275702ae55f0dc9\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"8d2a3f5e8894a058\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"0d14b3f93da538f1\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"26378f6aca3fee2e\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"47645f33bd330c2b\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"a9f3fa9075af8c48\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"a767225db42dc0e8\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"814acd65683074e7\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"c068e68546b3f4ff\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"02e65d4353a556da\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"f5d6e1bab3c9f2e2\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"47cb24b1b78a1723\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"0a4b127d768ba128\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"a1fc6f3af9155341\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"0de9f6708b5c890e\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"0ae65c11000707f9\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"8a87429aae12db72\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"b2f544335ebe614b\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"e5c9c5e751684115\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"74d89d50bfb21366\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"decf223ed6a08c10\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"889ee514e18e3033\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"6d7c9a3084b6293d\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"dfd641426f958a5f\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"ed1485bc60e96a0d\",\"/knowledge-medium/src/components/references/CompactReferenceLink.js\":\"ced9b5221e2e051c\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"ed45611920c004b2\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"082a99bc8d686f26\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"9c6c4dcdbd283309\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"d3d17f250253e05e\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"a1fa5a25f2adb033\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"2cc6162c2b547d12\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"cf5d6b1f9d064c9d\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"78e959ee74d90761\",\"/knowledge-medium/src/components/renderer/BlockReadText.js\":\"a37e929193474c78\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"7b8fa40bbcbcccaf\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"b8308f2c66c976f8\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"9eb9e4c8c48af704\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"21416d6412c13848\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"3add329466046195\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"24ffc7698ffbccac\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"724d6536547b10e5\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"83fc8abd106d0144\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"8987612da7f2812b\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"ebe5402ddc9d4cde\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"7507a44bb8f87887\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"cfcab5e9104a95df\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"7ba324befdf8490e\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"63112a27476c133f\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"d7f47279a2bb5827\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"50ad2d82c26fb8bd\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"5db86f5237bb56b4\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"a47428eeef977538\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"73043e117d3705f4\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"b3df04df54c7aa26\",\"/knowledge-medium/src/components/ui/button.js\":\"32cffde565da8a5b\",\"/knowledge-medium/src/components/ui/card.js\":\"415f075dff014ce1\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"d1fb53ca15fc9255\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"b84a4241a10f57db\",\"/knowledge-medium/src/components/ui/command.js\":\"0e3f87cc9c198c36\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"238139d1a925610c\",\"/knowledge-medium/src/components/ui/dialog.js\":\"12cf7fce4ba78b13\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"e10e19a5e2fc4466\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"ea63cce28967f418\",\"/knowledge-medium/src/components/ui/index.js\":\"424b39571c50ce59\",\"/knowledge-medium/src/components/ui/input.js\":\"8b1835e039bb5cd5\",\"/knowledge-medium/src/components/ui/kbd.js\":\"496b821f528f9ca3\",\"/knowledge-medium/src/components/ui/label.js\":\"8d8c61d82cc5c449\",\"/knowledge-medium/src/components/ui/textarea.js\":\"ef3ae3c44ef6992b\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"7f90334bdcd7a6d6\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"757fb3c3d0eadb84\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"ee5cd5c5352d8bc5\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"1201b49e13ade43f\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"08bdf975e5ffb225\",\"/knowledge-medium/src/components/util/error.js\":\"a250df8df4c8e91f\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"2d6141bfb6d275ee\",\"/knowledge-medium/src/components/util/suspense.js\":\"c44435d3d2bd2d05\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"17238fa37292036a\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"899cd3a114523c22\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"e48a9459960134fa\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"38fcbf8f82077560\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"0df1314698f29c9d\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"61b6781e6a65eeed\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"7d3777492993dd39\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"bcd30012e5aa7ada\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"97305dbd06992991\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"29443c0ddfa0c451\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"7c0a2ac8904b5b02\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"93c0fb65adbafe44\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"12cc309ad1507440\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"de9a2557abdfd14f\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"2a232e15d06210ab\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"590128b22d2b679b\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"c249740f79edcc6a\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"140034b019bc8b4f\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"634f7e13e5ba7332\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"a5b17aa329a1a3a3\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"ba5bfdf5a8a6b2d7\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"c099958cfb1268f1\",\"/knowledge-medium/src/context/block.js\":\"f9af1a3196845046\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"ba56ce0e5e544114\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"cbbb1dacbb27e20c\",\"/knowledge-medium/src/context/repo.js\":\"4310e5e8f8e89b75\",\"/knowledge-medium/src/data/aliasClaim.js\":\"f6dff230920aee03\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"15779a5d64372564\",\"/knowledge-medium/src/data/api/blockData.js\":\"5ada65a5da9a9207\",\"/knowledge-medium/src/data/api/blockType.js\":\"31608dd75bc2e463\",\"/knowledge-medium/src/data/api/changeScope.js\":\"ce3b3b5a08b8a0e8\",\"/knowledge-medium/src/data/api/codecs.js\":\"ebc92ffba6ea0875\",\"/knowledge-medium/src/data/api/derivedData.js\":\"d2894418bd177188\",\"/knowledge-medium/src/data/api/errors.js\":\"4f0c24d94f137e8f\",\"/knowledge-medium/src/data/api/events.js\":\"6c9a869d74e16ce6\",\"/knowledge-medium/src/data/api/handle.js\":\"a382c64a1c8f00bb\",\"/knowledge-medium/src/data/api/index.js\":\"1ed9ccf588e08619\",\"/knowledge-medium/src/data/api/mutator.js\":\"b0acef9e22b1ead2\",\"/knowledge-medium/src/data/api/processor.js\":\"8a0236a9ba8efba8\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"b233b7d25a7bfdb1\",\"/knowledge-medium/src/data/api/query.js\":\"a54823109ea733f8\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"85b287d4c08dae92\",\"/knowledge-medium/src/data/api/schema.js\":\"a382c64a1c8f00bb\",\"/knowledge-medium/src/data/api/tx.js\":\"a382c64a1c8f00bb\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"86dd1f4619ec377a\",\"/knowledge-medium/src/data/api/user.js\":\"3c1831f6deedd34c\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"05a71e7a6481d417\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"3cb0fd4cc246af3f\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"3f27a7f8ddbc3c32\",\"/knowledge-medium/src/data/block.js\":\"8132eaf4980e234e\",\"/knowledge-medium/src/data/blockCache.js\":\"fb8cbb120fbb598f\",\"/knowledge-medium/src/data/blockId.js\":\"668cf144e5eba8bd\",\"/knowledge-medium/src/data/blockLiveness.js\":\"c8355027741e65b7\",\"/knowledge-medium/src/data/blockMerge.js\":\"a9f7e9536a882b2a\",\"/knowledge-medium/src/data/blockSchema.js\":\"eca162ed97db8e0d\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"71bed29a977acf65\",\"/knowledge-medium/src/data/blockTypes.js\":\"64fbc3952a6182b9\",\"/knowledge-medium/src/data/childrenView.js\":\"3b43a11ac13c49a8\",\"/knowledge-medium/src/data/clientContext.js\":\"a886091edde117d0\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"8712e272f72b366c\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"4785ca032a8b2792\",\"/knowledge-medium/src/data/derivedIds.js\":\"45f8bec3bce723fb\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"ec5f9f66c9654f74\",\"/knowledge-medium/src/data/facetBridge.js\":\"d7bfd6e1d828796d\",\"/knowledge-medium/src/data/facets.js\":\"a46ea0cd0ece86cc\",\"/knowledge-medium/src/data/globalState.js\":\"aeb12fce1b7ea77d\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"bb658b282609ecbd\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"33b00eefc57e5a78\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"6d4fe601eab867b3\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"3377f379bc9c1ba2\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"db427167ad22de22\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"3b7e007e1d3d50ed\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"84d61ea7dadc5c23\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"33720822cb29e3c8\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"8f6e91bce0c60cba\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"b7040d3e9003a58b\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"dd0a8fdcdd113399\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"250150f101e094a8\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"cd15c36143f1ac90\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"9ce8eb69030a9889\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"7c49675562e94cde\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"b866ef7a9f3ddf72\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"a0c24e0251ca8c5f\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"76980097db3c7e2c\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"98ab4741b7081511\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"34e63ecce685a085\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"1e7743862ae03758\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"9bb65069b412218d\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"ea455cea6f4e2ecc\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"2cb219298b3e0c94\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"bb0f525eaf0b5354\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"43a1eb89d141761a\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"6c36997eafd55c0c\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"6f6a435cbf1fbc5a\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"b76b4a3bc8219d1b\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"02d86021a5870079\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"8131e872adb5e669\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"e279fececcf890aa\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"2102ec3a0460ea62\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"59f28ad97904e35e\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"73d843d181332004\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"4db917c370777063\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"d73f8ef871866043\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"4049cf073ffd9dc1\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"9d66f4b0262025a1\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"8bd6b9dca02b4d92\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"2cc6085d0a93976d\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"a866adf100050b29\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"3a0efa801a5a2d5f\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"7f5795800fe9a78b\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"59aab9ada1117f15\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"d91f6053579d2f8e\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"9e36a7900a8ab8bb\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"3d810b450265c816\",\"/knowledge-medium/src/data/invalidation.js\":\"c7a12b3ff044af9c\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"52ed3cdcf4209779\",\"/knowledge-medium/src/data/kernelPage.js\":\"f0a61da5830eacc8\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"802f4216d15e6966\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"a40a9a55d2056040\",\"/knowledge-medium/src/data/localDbStorage.js\":\"59bd8a49e1f3ebc8\",\"/knowledge-medium/src/data/localDbVfs.js\":\"38f07daae48e33e9\",\"/knowledge-medium/src/data/localSchema.js\":\"1b08bb09a8d5d09a\",\"/knowledge-medium/src/data/maintenance.js\":\"22e353350004b736\",\"/knowledge-medium/src/data/mergeProperties.js\":\"df326169811af8ee\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"c47fb02dc46bf80d\",\"/knowledge-medium/src/data/migrationsPage.js\":\"54d0c36aadf00bfd\",\"/knowledge-medium/src/data/mutators.js\":\"e5bc56949ee37e6c\",\"/knowledge-medium/src/data/orderKey.js\":\"5eaf2e6f6fda5657\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"c7ab4a1706117cd3\",\"/knowledge-medium/src/data/outlineSurface.js\":\"34b20ba7db305093\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"c51245b0d862bbe9\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"a71d4ffb47a956d6\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"72d1ef76444e9353\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"f48587baf7cd7e89\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"fed1e2630724940a\",\"/knowledge-medium/src/data/properties.js\":\"0c29061d6fb473e6\",\"/knowledge-medium/src/data/propertiesPage.js\":\"c6bbfe9ad5127630\",\"/knowledge-medium/src/data/propertyChildren.js\":\"313fc917f47db1a8\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"7b683135b10cb76f\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"40def2053c471216\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"83bc76373a0d0406\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"cedaedb27610d72d\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"29a7b5fcecc42a14\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"c6c4c43acb02a5b3\",\"/knowledge-medium/src/data/propertySeeds.js\":\"c471fd49af33c6ca\",\"/knowledge-medium/src/data/recentsPage.js\":\"d10b80c35030cd0f\",\"/knowledge-medium/src/data/refTargetComparableProperty.js\":\"1d3ae01c02f9c4b7\",\"/knowledge-medium/src/data/referenceBlock.js\":\"020e18528c5e1332\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"213c4cf503d5ba73\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"92bc73f04ddde8f9\",\"/knowledge-medium/src/data/repo.js\":\"d03406a01533ed07\",\"/knowledge-medium/src/data/repoProvider.js\":\"9c23db63d60ccb7b\",\"/knowledge-medium/src/data/rowProperty.js\":\"6fd1b1d11e85f15d\",\"/knowledge-medium/src/data/searchFilter.js\":\"c8b3cdf7f7b7c606\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"c02c2d6f993caab7\",\"/knowledge-medium/src/data/stateBlocks.js\":\"9baf511b210d759a\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"7240aaba59071576\",\"/knowledge-medium/src/data/structuralInsert.js\":\"04034cb39a188a21\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"84eb35b950540703\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"9ab5812d7ebc9590\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"6843f8f9ffee5dc1\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"2fb164aca4d00b98\",\"/knowledge-medium/src/data/targets.js\":\"a9ba79483f2bc8bb\",\"/knowledge-medium/src/data/typeColors.js\":\"ed1c53b526e1b5d1\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"5eb4e0b9527f2231\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"bf71a5585d2c3cd2\",\"/knowledge-medium/src/data/typeExtraction.js\":\"1f416b3e3a1f9133\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"4897aa307669c828\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"50e61a71cfe6f951\",\"/knowledge-medium/src/data/typeSeeds.js\":\"dfa2fbbb77f37de6\",\"/knowledge-medium/src/data/typeTagger.js\":\"5a9c95976da7aa03\",\"/knowledge-medium/src/data/typedRecords.js\":\"c050937160f68e18\",\"/knowledge-medium/src/data/typesPage.js\":\"96c059c72f42fb20\",\"/knowledge-medium/src/data/userPrefs.js\":\"0e0ee47d76984804\",\"/knowledge-medium/src/data/userSchemasService.js\":\"d7d1dd991080a457\",\"/knowledge-medium/src/data/userTypesService.js\":\"67c0049d3e72efdd\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"5915cc7aac4a8420\",\"/knowledge-medium/src/data/visibleChildren.js\":\"0f1bf00e3b84c867\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"86524f210225a060\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"e0f9d96bf7e9cc2c\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"a90fdb9b59ef9e69\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"99a888cc8bc28394\",\"/knowledge-medium/src/data/workspaces.js\":\"b6fceadecf459965\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"291e5310832d3cd7\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"93b95a19604261c2\",\"/knowledge-medium/src/editor/atTrigger.js\":\"2f259d0dc7fb7dcd\",\"/knowledge-medium/src/editor/autocomplete.js\":\"313e994687182759\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"cbe068c64738c29a\",\"/knowledge-medium/src/editor/contentFlush.js\":\"54edc161ac7a0094\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"306c7e78c1338fdb\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"a6560d3c3853e90f\",\"/knowledge-medium/src/editor/insertImage.js\":\"f136ecd331b7691a\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"9a72e28d3aff7bb5\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"7c15894d7949296e\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"d7900f6a1d9235e8\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"7ea1ac17571cd9e3\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"367d202df5cccc76\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"59007e91ec0c168d\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"23e2f521c2f4cf02\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"86944ef83ffd8126\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"5e7c216008a543b4\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"258e90035201a655\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"33fc5f26a9181575\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"3bd0f0807f950dc3\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"827b20dcf11be0c1\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"12dfa2f0521e578f\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"9ca682b2436b30d6\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"374bcd91c06b867c\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"7ed6d0900af94ff2\",\"/knowledge-medium/src/extensions/core.js\":\"9d2b12bfc8da40f6\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"0b9373701ce8a0eb\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"0914d70157a3d811\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"a09c62fdeb27a5cf\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"3eed5f6017fab0f6\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"eda887fc1fc27f7e\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"2780f8f6af5982af\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"868d2ba7160e1880\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"1142bb2c59e94390\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"5a1a31a454a11c69\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"3ce9189cac356af2\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"27794d0a6c92ba83\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"9dabb0529e4d06a4\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"17a78c1465b7226d\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"5946d5d7ed9d86b8\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"84ca8c0102b68587\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"175ea5cf2b97ad61\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"b4eee6f4987bff2d\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"fbd841d02d52758b\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"ce48bd14afc9f3a6\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"398369f0c7f8ad13\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"d3a6abfb54290e1c\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"95ce743f4dce7369\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"24a9d4db737dc6de\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"164cc09438f14bf9\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"b38b3d1e7896b254\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"706f04ce581f6d35\",\"/knowledge-medium/src/facets/facet.js\":\"65e98cbbb926b7ed\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"3a02c7b5fda5f211\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"607c717288183d4e\",\"/knowledge-medium/src/facets/togglable.js\":\"e1ce4948288a97c0\",\"/knowledge-medium/src/facets/variantFacet.js\":\"2951a88f7b8df232\",\"/knowledge-medium/src/facets/verbFacet.js\":\"d9e83e589bdcb333\",\"/knowledge-medium/src/hooks/block.js\":\"35a59a6fc480e998\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"050e6e91cea912c9\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"8bc544fabe2f77f4\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"45350a794dca8b91\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"4837a06d65ffe7dc\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"538e8c7aed349fe5\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"ff06eee77bb4a690\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"202495d9d3d6ab78\",\"/knowledge-medium/src/hooks/useFacetValue.js\":\"3b883c894413a66e\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"9ee106ec78febf0c\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"b2e8e9863d99d81b\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"b7c448fd1d3acd89\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"709fa207f38dd5f8\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"bd9e345695317ac2\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"5372f0e093a49353\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"1abe4211c4f1dfcc\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"da364f2cee3da41f\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"7d2241c2059bddf7\",\"/knowledge-medium/src/lib/utils.js\":\"68851cc4b2b50dc8\",\"/knowledge-medium/src/main.js\":\"2204c560e8f9e1fd\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"04a8c6f7da3c9087\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"49ca0d4fb420744c\",\"/knowledge-medium/src/markdown/context.js\":\"d83984ffc7a02b2f\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"78471e15f3aaab24\",\"/knowledge-medium/src/markdown/extensions.js\":\"73395ed2956103e8\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"1087ac43b922a34f\",\"/knowledge-medium/src/minimal-editor.js\":\"5ed041c5c2cf32d2\",\"/knowledge-medium/src/paste/armedCut.js\":\"674613c1c73a9b4a\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"4fe622f22a56bdad\",\"/knowledge-medium/src/paste/clipboard.js\":\"d7f32feb6a376251\",\"/knowledge-medium/src/paste/decision.js\":\"1f4167adf85c11d8\",\"/knowledge-medium/src/paste/operations.js\":\"e7096bc17bade5b8\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"02be306ab8bb261a\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"372b6af75d13ce63\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"c425ce6ceb0eed67\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"56d9b805d276f488\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"d21cc3ef156b911b\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"d6e5bce12f6798f0\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"3c78162379a6affa\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"93d89eec4bff12c6\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"3b4ad77573b8db18\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"cd2bbbb3b2901519\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"b488a495bf567e01\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"adea8588f01148e2\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"4189502fad9ef7ae\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"229c5329efddce11\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"7ff5df7998816b5a\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"9d418eb3ca87c16e\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"597b80e69222e353\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"9204bb90c6f227e3\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"5bcf8e4854793570\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"f56a360d6e42b9f5\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"931eb3ab7cbac48f\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"f23a0063894303e1\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"605ae040a75cd3d2\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"6166a36e2358c4ba\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"3c5591241fb506fb\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"5d87b9a2bf0bc3e1\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"7cbe713b1e99da94\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"afe78e6ff3144030\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"25efefb5cbaeb180\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"6e2b781ab8553ac2\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"05e6f54409470064\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"6f4143ce960b34f7\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"fc48e9e7fde98373\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"66e36a0e330b6db5\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"94764bab1342874c\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"1bf605a8e50add20\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"302f75f11aa8b81f\",\"/knowledge-medium/src/plugins/agent-runtime/dayPropertyInputs.js\":\"1fe9c87f3e17d472\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"13d6c0c6d0211e8d\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"753977015f8421f6\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"eb825bf591f5bd13\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"a5173840b35bc320\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"f010b9078f4ebdf3\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"2754ba81e37d2714\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"387d74396fad5bcb\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"b2a6b3964d7943e8\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"9e629004936cef19\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"d66de4d9e3c37d6b\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"3d866da1166aea8b\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"f952f8fb55971f03\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"b63cc4e3e161a846\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"7e6c7213c23d065b\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"19512f36d8251921\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"323f73e65cdb4bf6\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"c7751947711063cb\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"6fe090071d6f8d6f\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"66fbccfeee238576\",\"/knowledge-medium/src/plugins/alias/index.js\":\"b844fdb054f78d75\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"2f4e82eba980d76a\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"45a13b5bdf924827\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"8a35cf3844832093\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"e57a1c2e2f97ac6b\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"96985c328d23574d\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"572a92901d8d1993\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"6218958d42765f2f\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"3e3990ad59039ed7\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"40c35bb9c855eb29\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"707ac8c77be4e5cc\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"ae0d9dc8e674dba1\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"263555b85077541b\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"f1a294dac6182f11\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"cd462df885b6fd6d\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"9d112fd9403f4923\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"ad5c6824bf0eed36\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"2f2b32d94c204773\",\"/knowledge-medium/src/plugins/annotations/marginAnchorLinks.js\":\"21380c9984abadf6\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"d34da8ecdd8c1aae\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"1cb3259d1bc87296\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"0cc0657028848b64\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"e2d616b234715039\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"4d9235bc75f27a0a\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"296faaa9394eeb59\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"0564aeb5788cd305\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"49d46569e604cdda\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"5839a3abd62f8428\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"949b3f29d48a2b0c\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"7d9d4fb4c2048639\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"e81cf8bfba972f6a\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"546ee217ad932249\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"0e26653f86b2a7d0\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"540cebcc80748ec3\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"f62fc41904139da2\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"f97ad624b1d0540b\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"764f09c71b5f59d6\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"a828d84cd73e823c\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"6895e91edc2803bc\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"774421ac60c6f3a4\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"8eddcd0ff8f51e81\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"3807d430a7cc1486\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"6e14f81e1dc9883d\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"8137d81e62f205b1\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"d7a280e4dd724fa8\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"975ca931146e6e80\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"4f9181b20ef1e042\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"24fe21769e3a5768\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"c378074be25765c8\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"aeccee1a64a1e7f9\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"3f58126b220e6003\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"262a6764e8ab52d7\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"2c0cae158847e0e8\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"8c0c81a661368839\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"b56f30490af74e9b\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"49b9d32d7dd36284\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"a4cd9d253e879e28\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"23b23acadde0569e\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"e80a2949a65c6cab\",\"/knowledge-medium/src/plugins/attachments/browserMedia.js\":\"87c3c077019d7fca\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"89e40c2bf98825eb\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"4a8e61bb6f2b889b\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"be959d858c533e08\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"b56838d0afa15714\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"5a3d5112f3540010\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"8f88fc2cd1eaf87d\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"081f84765847cb11\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"b5341c8d0804fbc0\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"e5c7aa49c66dab8e\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"e8ced39b9d690301\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"3f55c83672e7beb4\",\"/knowledge-medium/src/plugins/attachments/mediaLanes.js\":\"2fcbd5f9dcb1d5ae\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"6c26b2ca2bb1a045\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"1472bdbd6fa40297\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"8ab1e60713227a76\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"099a872853801950\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"e44b21141044bfbf\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"26625885f81c2bb5\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"44ffbd5fa3607f74\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"cd14dd2b0cb384b2\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"546c6fb4c25e1890\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"c729fa5ffee48c01\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"904d016e14a00bcd\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"e146e087c8f02abc\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"77eb1561ed2001be\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"c6174c070c7069e1\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"24731c7629f76af6\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"8784bab9f083dfab\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"858853096a79f072\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"9742bde7aa507e38\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"a7d5918d506ea923\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"831aff1aae3ca906\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"813d70c9730aa5e8\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"595d8e51b7a27c75\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"ef2db0f9841610c8\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"419f7b95380d6dc6\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"8feffc5b63b9922f\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"e2518e65ac3c63c3\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"3549e9e77118b000\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"b1a3ca917f0cded1\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"e1e868b4dd5c754e\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"eb210fb3044b7aed\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"51dd33033876f068\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"c5d90934ed03316a\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"4f330d54bd68ec0b\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"02e2de215d81e060\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"50555ee9d094218a\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"7225772ea45938ab\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"a3746f006edbdcef\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"367dd14cebc59e7d\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"45a26ab7d8b8fcb9\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"23f56e12968b733f\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"74bc6fac59fa3268\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"89cb9a2e07c4c315\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"0bc0b5b1d8c6587a\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"fc32c7963a71ff04\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"9bea0a0e046e4d64\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"cfcdb3eb4d283b33\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"2c249734de0a302f\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"e40b40a50014c008\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"482a789126bdca0e\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"dff2290029c6fcfc\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"b1ff8266a1c15467\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"c595710ef13a4b26\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"6851eab944c7eadc\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"35392900f0f63da3\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"a975d2be78bdbddb\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"18217c47ce55b477\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"1dc0c93a80c1111f\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"7639f174c08555e6\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"f7ca656c31cbe844\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"333fa8a1debfb5ce\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"727ea5fc5f6468ac\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"282f9762aea10303\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"b76b9d3b690e8542\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"6c206a4e85b44b9a\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"7ab75a16b36d2aba\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"3ad2c27814116589\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"f9b1a505716caa67\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"1c2c251ce8f8acea\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"df346b38f96bda63\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"25d017a5e013d0ee\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"bcd24c1c87430c71\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"515937fe53b41dbd\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"7b86ed8620d351f4\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"7df32fb14f93bef7\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"a06265ff720012d5\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"8b678486b7c43a44\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"8e92357cc72a8e6d\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"74e6acc062c07a65\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"37753142da4ae90a\",\"/knowledge-medium/src/plugins/character-counter/subtree.js\":\"8c54168ea1b61e92\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"eda43f23279aa368\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"0f0730d982c54d90\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"297b1df17339ad3c\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"a91160f2bd76c0f9\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"b75a7c33402498d5\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"06319a866bc9f08d\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"08151f9d57acd1f9\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"2275e60836016b02\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"477f6dce7f2c69f9\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"526b33d0df010400\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"216b22a8f2924c5c\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"07474f7ee706fae0\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"c91e55fe520edc60\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"4cc26e10f0c81a0c\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"49e7512eef7e9582\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"acafc0e3b5f5202c\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"fc2339355f0cb9a3\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"768273bf52ad1c13\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"f87fbed475dd4ac2\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"a043f6e36ac091d6\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"1c9544d4021cb1fd\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"eae693cc841a6fc0\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"737341eaff1b39c5\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"82e7bbecd53cfd2c\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"f442c428dd8821d4\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"918d7016fa00d659\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"0e84b8fa02f9b69d\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"0a84ca0e0744e998\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"fac7ac29d5d5ed71\",\"/knowledge-medium/src/plugins/daily-notes/DayPropertyControl.js\":\"01e74b95be620ff6\",\"/knowledge-medium/src/plugins/daily-notes/DayValueReferenceControl.js\":\"2ab91ef6c5051485\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"57fd6769ad2c5c67\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"bf74b18731f8a086\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"35b2a788f5bdaf70\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"6810580de1b7f477\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"e0a63093ce8a27dd\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"38ef7dc5ff008dc9\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"1edb67d2679eec3f\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"6f9c44161d6d4592\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"f4a754841e5d26f7\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"7ce133745444a9f1\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"76f8fc95a88b85a3\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"78d6a1ab53ecc2ae\",\"/knowledge-medium/src/plugins/daily-notes/dayProperty.js\":\"b7b5700a6e4857cc\",\"/knowledge-medium/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"43aa09e5419638d8\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"b15a8c304dd524af\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"a6ce6264a5e17ed7\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"0b43ca3cd0b61adf\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"0322dab1db4b025f\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"ef62ab9ec0ca711c\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"0d80feacb82d3f1d\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"ce0256728cb18bc8\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"0a228b1f86f38164\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"785d6c0cf60cc6c2\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"97eaebe09d0b3ca1\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"8eac5aae695c93ec\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"8c78d09c71e7c3d7\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"94598d7268b5224c\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"7bfe5856b84a6dd9\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"28318f80f4bc84ad\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"69383dffbdb42ffe\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"7c4ae95928f84417\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"8cf12e4ac388c4cc\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"a7d9b658de1aeca6\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"6be079fed0fc5693\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"fb64db3bf96b8326\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"521f383485efb28f\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"8a6481e70fc5430f\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"6b1c4feb8d141556\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"eb6f13f68a98da06\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"5b56909de91d2a66\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"537b844e51f8058b\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"05d92104ca0b3b84\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"e174c5af3187ba9f\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"3f47863ed6ef91c4\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"f86ffacfb610db91\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"4a94d0e99a8be271\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"22928c1ada9d1a91\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"d3b5fe93dad6072c\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"061929349235dd3d\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"f06fae4fcd81ba6f\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"fcfe9a2927e6b16c\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"ee8587323f340b25\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"7489d1fb8981c92d\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"aeedbeca094505ed\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"c33f574dcf3bc0bc\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"b0960d7ba67938b8\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"2638a538d3eada0f\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"a71f9f5159e57f3b\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"66c2914b673aa421\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"f0869ba8b49776e7\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"c533b31b51fbeb72\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"1797d856279c62b7\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"930c7ee0d1b9a016\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"df19bde6ce23751e\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"6c7e3a0d86543756\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"d3b574a0c9c4d83d\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"37c7d219c7eadb50\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"f2bbbb9593ea623b\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"86f50125e85e9eb9\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"a6a42d449fefd920\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"53da0b2809cd08bc\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"da4dd66142fd7fc6\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"3838c4ec80760f26\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"517626c24f5492e5\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"c02fd3a38035af7b\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"588065ed55dc82a5\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"ab3e74366c12420b\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"d2e9c3d46da0570c\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"77729fe40c691967\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"d665758d8c07efab\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"90f5110120ec457b\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"b613eb42ab0ade47\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"d07ea3ac49e31731\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"26d75cdae06622e1\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"94ae3040a2b3970f\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"eacc14e796cd52e5\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"2ed0cd515d9ddde2\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"885454b53cbb5ede\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"bd73e513654c8a5a\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"528d0ac202c09005\",\"/knowledge-medium/src/plugins/geo/index.js\":\"b1f7242a959487eb\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"db0d96218fe61f67\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"d2dc73cc77d11dda\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"488e37a6f5f55825\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"490ef753ac772e35\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"b323cfa6d2e2b57f\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"23d398429ddb6b45\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"c2c2e629239f69a4\",\"/knowledge-medium/src/plugins/geo/query.js\":\"01ca03b77a299a92\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"048bdba7a6785ede\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"f868cb0d6d05720b\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"134f2e9fdf19dff5\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"758bebfef8e2c317\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"f31858ee19bb70b3\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"b6dde3d8d6408389\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"6a9a661fa1bf75c3\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"a64f91d1f9dbcd51\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"c7e83997bd1731cf\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"efce822dee1e7626\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"6c6c17b585702835\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"766a64ebf9d74334\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"3dcb1d061f2c675c\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"3b59ee1badc6bc9b\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"bbaee7d68201c65e\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"6a85277acbee7c9f\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"c3fc689958f6e44b\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"8494f7c963127309\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"967410f5c119dfe0\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"f72f955114f18b48\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"ce4bb05e41feb868\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"45e6eb89ef40e2a2\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"842ff50dee1647da\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"3f33996bed15d3a9\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"45030f064bf1015f\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"32916364f43ea69f\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"f7e2a85f9b00ab88\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"3411c185e454d662\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"e95bafd05c541e77\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"c8679a7c38521272\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"563b00ad2c968ab6\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"561459c38acd5541\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"57fcd111f927684c\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"f1662f332ee9a1fe\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"0e0280bb7d5a233a\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"af82cb6c50f30988\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"a3765b67cc43cc7a\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"238ce1c2d9a0501e\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"c01e5b3f979e6ce3\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"3335d2627349e1a0\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"f650f997abe24c4a\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"ad6189fa118fec21\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"8f85ec8ed979dc44\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"479683d807ebc491\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"48161fa45d29d390\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"95b1f66fb58e1855\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"08f797878a1613dc\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"d3b886a1a76683e8\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"a3ea81d9ba933f57\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"79358dbfe09f1b29\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"282da6df2355dba9\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"29a80f243481c7f8\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"7034a9371ada7d97\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"975117db68827420\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"40e2f9953e283636\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"0fbfcdefa0dd6d6a\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"98fe7b6e1a141b57\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"b6491bc86a564cd2\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"59c1576f4adad3f4\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"c4089fc9aeb6a66a\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"848c3807a373ac00\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"bf6b4973a2a0e7c9\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"1e7e197f2aa9239a\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"819d7ee7558d3030\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"c088a12c3e313f31\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"f2b93d85474766e4\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"c8a019d1bfefacad\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"740cfb39b3ceb7cd\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"e84662653a218729\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"ba3d3ed7a670c0db\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"5a4eba8cb70b63a9\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"46ed6e3a1fc082d9\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"4835c5a59ef2b4d0\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"e562e577f1fdc829\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"c1ffd753e7a2583d\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"caf2c4e06e0f5a41\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"79b3504d0f56b417\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"a4711856bc9d385e\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"e0df85931dde4526\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"cc7da72f37536232\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"41b99b6e0078dece\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"6c92aeb43b060e69\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"2ed955646d4ed290\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"04eabe1db6037048\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"4f2144284ec3efb5\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"886b29c4235ef9fb\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"bd82ad1188197b48\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"a16cd8e3d9f04a72\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"0c24dc0f698c345c\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"f78008bf87eb548e\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"ca6295579043c46a\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"23fcea53d4311b68\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"d9d8a1bc0df81000\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"49cef5d8d6596a5e\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"625ad482c5fb78c6\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"2bc1148971e89f74\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"1f57da3a2b72e6ef\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"86e57c1bde09886a\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"b21e1c89f594bb26\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"85d8eee7a35ed4aa\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"a29b4dd36d0584f6\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"7efb1d274bdca2ce\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"7403e71505ac4e49\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"75185a017cb7c7bf\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"833e2f53a84ae52d\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"6d32d7b325d88aba\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"896bb4bd2642ac66\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"71dfc3b65de33081\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"89e3a649408a8d9f\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"d4f0f3133705ca3e\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"7b13cda031a2d561\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"f3bd5fd065696aea\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"50da25908b7f3219\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"81fd92ab8a349496\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"9364bf8f2ae52461\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"95b5ec5f518adca1\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"4a4e0a0dd2f7622b\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"381f72b738ddbd08\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"cd95cadd10bb9ca5\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"0fb1dfb0435efe31\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"03a8302a113c3fbf\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"46b92fea4dcc27a5\",\"/knowledge-medium/src/plugins/recents/index.js\":\"a0b7888277337d2f\",\"/knowledge-medium/src/plugins/recents/target.js\":\"260e93fb92706e7d\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"b5f998f773c34e1e\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"8fe79e6c2f027228\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"7bbd455bc2e53fc0\",\"/knowledge-medium/src/plugins/references/index.js\":\"e785da3bc9b0cbc0\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"ab927669a6d54bca\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"48a89ba54ea099c4\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"66556abf04dfd5e8\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"2fa8ecf18d3b2872\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"c0200a0d854cfc63\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"fba30368c70b114c\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"0d16adc022c10e6e\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"7895f1f0aa942ab2\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"2d2186a31aa45aec\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"dfe6dd49526cf03c\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"d9cb3ccc65b04211\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"dddd0c15313ba763\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"e6bb18a46120de68\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"6aae701373e613ff\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"78e2b8e9a53a050e\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"1a41cf9e2dcb440d\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"1b5953c727b4c17b\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"d8efa6efae7d960d\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"65a3a4ebfbbff407\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"a68dbbca9ca99304\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"96cda1d79d21cefd\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"77541ea3ebacc64d\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"4a4a06ceeba69855\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"bc082e7ef46fddd8\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"bf88d355577303f6\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"5d69b00684dd1959\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"fc65262c916316ce\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"e7209e44baf0b9aa\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"3467e754da4e06bd\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"d75a80cca3218978\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"7d60098cb05c6ae8\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"cb7eb32c13562f3f\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"8105f17c6f0502cc\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"748c2d8a5ca7a069\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"6d86f2d40db5a65e\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"69e3de15eafb67e3\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"b48495768be6c685\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"2668b1896325b3cd\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"d77d5c47791050db\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"9eb2486b47bf88d1\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"daa48a7eec257850\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"eb23b5889ef7054e\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"32ff4039bcbee06d\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"c168def8f628c8c3\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"e296a35937be1cf0\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"004d8b4fba1380f9\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"6e6a9080cef57e76\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"6e8cf4b1d3fbf9b2\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"eba6be2dfd1e2620\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"8afac48b61c6f581\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"91f4f23fed9e44a5\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"0e28e2cd071149f6\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"eb93771009d45810\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"23656e3cdec7a8ff\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"3433e7bfeb68a5c6\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"3b539823e1385955\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"0d6637547dd90cfa\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"ff32bba36fa7ae80\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"d4edf838b5d5058b\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"d652aaaa5c732fa5\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"46ea7f86d44158bd\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"e48b123d6cc0bb0c\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"a662904f10accf93\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"35a3206f48d1b6a6\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"6efc533b04ce2829\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"d43e2381ecde29ba\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"418f00d488dacdf9\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"595483279de9303d\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"272feb95d02408c4\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"2914caccbdc082f8\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"8c1db705408bea94\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"9d5c9bfe015f230d\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"c92bbcd2c36b3c0a\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"db086bd2b698da64\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"eba5bd729265337a\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"8e82e4b4d2af42fd\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"2f821c8be9d7fb60\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"5d4abf9d110cc5a1\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"7ad4c5402e6fa1a7\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"f39972c14d3d10d6\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"06542f0a81082e6b\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"69db24dda06340a0\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"85a38b6842a9d3ef\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"56286518e896c2de\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"9b57b8b5e1a986b1\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"681400e61771155d\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"4e3d98a73669cd3f\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"7d00cef0f350c21a\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"6b62d1e3f8d35a32\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"5b18b33bae1ef60d\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"d17ed33dfc6fa790\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"9673f864172de866\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"31ab45b26c7593d8\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"d7cc127ddf5cdd1c\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"3d2b6fa25590586e\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"c94f2a5636144929\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"3fc9e923213782ec\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"5ee5a9bf1685d170\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"e80a953581f49fe4\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"9cfffb5e73b2be88\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"877b37be6bfb5279\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"a605832d2b8ff672\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"661bef55f1ecc6f2\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"07d0fa421ab862ad\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"fcd090b16ee184c6\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"a3906166641dc6d9\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"a8134d0f2f517399\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"ed69463d1e9d006e\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"e78910c26231e0f5\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"db5ce3a927079a88\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"10e179dbc5ec5712\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"4ef842abee5d8edb\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"d04dec20a6459dcd\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"861b710b3ad66bac\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"49f3136b3cca66df\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"10af03f51bd1fb61\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"cf20e0265ef05e61\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"2950ad99a662408b\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"65cc21f24382ed60\",\"/knowledge-medium/src/plugins/tables/childrenViews.js\":\"7378ff11b5e933e2\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"d5ac3b62a6cf2084\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"5e1e203f981645d4\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"85001e18279a5833\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"a6b97d90b97d35c5\",\"/knowledge-medium/src/plugins/tables/index.js\":\"801f5e7b88d4ef0b\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"d542a5a42da659b1\",\"/knowledge-medium/src/plugins/tables/model.js\":\"d0bcb580ea95db10\",\"/knowledge-medium/src/plugins/tables/query/QueryText.js\":\"0a10f7c50187b4cc\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"dca3c1555abc0e2e\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"095c22529d6f740b\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"11dd07399a929735\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"b1ec7ab2fbe5b99c\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"9b3c5fa15e1dc000\",\"/knowledge-medium/src/plugins/tables/query/registrations.js\":\"94ecdd5e2263b162\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"d9206d5432505298\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"af34dc2055e9374b\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"a3ed590573be3059\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"c54e89fc375d1ee8\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"25d616ff9dbf8928\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"aebc2a8789e11085\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"fb09f769775dd221\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"1ed6168523c6bbbc\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"33b6776ee0bef96e\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"20dff5dbb028f52f\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"4a01c69092a5294f\",\"/knowledge-medium/src/plugins/todo/index.js\":\"7c95ee9d6f53a4b1\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"1cc316527805d8e3\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"e255c97d58781e0b\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"e37f176b9e5b9135\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"9d821c12fba02ae2\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"19257328fdabc4a7\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"786d94e6c083690b\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"f1c9a693c33b67c1\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"9b2a1e9eb59f0af8\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"3596e1590a821231\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"7ba902f937c3837b\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"73026c47e36a05cb\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"e7f6d0f759e056fb\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"45076fdc4fdba1c5\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"bb4ec39626583377\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"a27c0487daee7e06\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"5e0668e6c89a3d0f\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"e78acca13886ca3d\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"b34807e7f31c45b1\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"ebc96c7037d3a6bb\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"ce4f3c08ae962438\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"1f46ed83be9dd485\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"a2496f53f65fbda3\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"aa124fd414fa1683\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"5d0bdb5a0472b19b\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"e68762badfd25867\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"adb4e20b431184f7\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"b46c7c6df4f0169b\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"58e4793d53e56c3c\",\"/knowledge-medium/src/registerServiceWorker.js\":\"5de1af87266b2da9\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"7df2f7cc586423d9\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"ee65021c42794f5e\",\"/knowledge-medium/src/services/authStorage.js\":\"f0bf785f8eee2b5e\",\"/knowledge-medium/src/services/powersync.js\":\"9e1fa49ded21839d\",\"/knowledge-medium/src/services/supabase.js\":\"0356335e28de8c05\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"f2681e14caf9e844\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"57ec355abb365101\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"7ef294f7dce2d7b3\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"43e1519b21cd9806\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"5162f41daf070f76\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"eddc90a54085721f\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"84546f107774d3c5\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"6e2d2d1d4d9d748c\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"bd5bf55cf93b57fd\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"4c92b6effa1adfa3\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"a1be92e4aafd4d59\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"08d135945f0726e1\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"430220b21bcb7247\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"d33733adbc0ef471\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"62fa1746f3af14ad\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"6853c92bdfb5b7dd\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"96d011a108d76ae6\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"9ea57a887f28d594\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"4353d2b208ec7468\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"5527f02608768ffb\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"f8361b0922cd7262\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"6cc0bfa011ffe9fe\",\"/knowledge-medium/src/shortcuts/types.js\":\"64c512915fa1a0b8\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"c659c13d6c34404f\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"563118388565fa36\",\"/knowledge-medium/src/shortcuts/utils.js\":\"cab1d7ec0d3dc129\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"aa881263ef5bb371\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"7b42b21933039d93\",\"/knowledge-medium/src/sync/byteTransform.js\":\"690c1dd82de8a484\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"60d64c110b77716a\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"d230c7cfee2d711b\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"7421b85917f10574\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"46b1f8b6c8a8c7a7\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"01c4f42d10e881d8\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"8072b8660754fd53\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"0df9fc87e3a06ea3\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"80f14eee600cac60\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"80f61c68047dfbbb\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"e2f8d7519f75300c\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"01f71000ec9cb570\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"69ed6c511958b25a\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"90d53e3f94eef54f\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"734f3bc7053b168c\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"92c21a9e6f577881\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"62230bf10b1904ac\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"0bfc98f95036283f\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"6828c9040e8f7302\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"f3a4b03e4801f816\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"429528020200d8ab\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"a5c7b588b1a0209e\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"45ce3f30f1f881c7\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"71bd5e58bb6c42f4\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"62ccc9de3ad6c868\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"e16e31836ada6af5\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"56aca0b0aabe1f4a\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"6180719ccce3776c\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"5dca095daa3b198e\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"7556461c43e90e9d\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"9cb27b66314e9d85\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"c32a969fd4c573b1\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"01f7f80a46b1a04a\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"4bea04d70ed316aa\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"1d827ca927f9d33f\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"8e92f7eae8a2b8eb\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"17b61f1bacad0bac\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"e26440bbfbd39183\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"be7c5402219f166b\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"b5355fb12b9ad9e6\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"9b26db96e6500977\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"27c7c4ba257f0f32\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"da711160dff1ef5b\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"4fa45dc386a4f91d\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"4e294a02859efd35\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"37f0d0a95ec3f46e\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"0df331c10123a39d\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"bc0681e3212e3932\",\"/knowledge-medium/src/sync/transform.js\":\"8e7fe9353778531b\",\"/knowledge-medium/src/themeBootDefaults.js\":\"bd207089d714da9b\",\"/knowledge-medium/src/types.js\":\"7537c30816cea204\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"ec97b474647fec2a\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"74370e7208982671\",\"/knowledge-medium/src/utils/array.js\":\"60e7627adc5a3e66\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"80fb4563758e575c\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"ed018782e23394d6\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"d426f1a4f8cc3ee7\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"fc9d42cb5caee3a7\",\"/knowledge-medium/src/utils/callbackSet.js\":\"9bc0386cebb09152\",\"/knowledge-medium/src/utils/clientId.js\":\"88988dc835c5c5ee\",\"/knowledge-medium/src/utils/codemirror.js\":\"1634c290703acbec\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"b285e769285a3cd4\",\"/knowledge-medium/src/utils/copy.js\":\"c1f2b87fee01e6cc\",\"/knowledge-medium/src/utils/dailyPage.js\":\"26a1258f4b767d4e\",\"/knowledge-medium/src/utils/dbForensics.js\":\"c33db2422e5e49f8\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"d286918f48f1923f\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"7e3ecf85a0c01980\",\"/knowledge-medium/src/utils/dialogs.js\":\"89fb325c70171ebb\",\"/knowledge-medium/src/utils/dom.js\":\"05b406d6251f90da\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"d34991602006d478\",\"/knowledge-medium/src/utils/drawnWalk.js\":\"054b1f5bab009628\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"8b685a957acd0fdc\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"8c8ac3e021c1cb15\",\"/knowledge-medium/src/utils/flipSlide.js\":\"3ebe308ca0972e37\",\"/knowledge-medium/src/utils/fnv1a.js\":\"79ed01c505c6ead3\",\"/knowledge-medium/src/utils/formatBytes.js\":\"0ce31ffed1b83df2\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"206ecd451ce5fbee\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"9c644f7eb72bf427\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"31185905550abdb7\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"241202c9355aefa1\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"09ec0cd1ea092012\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"777c32c980301d86\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"f3c9eed36d31dfab\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"29b5a603db292bf9\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"1c1cde908e77e6b3\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"90b16846b085e14d\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"8d3c9c02b5f91e88\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"af9c4a0c148fe7e8\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"8fb776cde46e0120\",\"/knowledge-medium/src/utils/markdownParser.js\":\"f4475079af2568b5\",\"/knowledge-medium/src/utils/memoize.js\":\"558b1ddfd9e663c8\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"31c36805408a1ac2\",\"/knowledge-medium/src/utils/nameList.js\":\"73d95eabf6db9478\",\"/knowledge-medium/src/utils/navigation.js\":\"8722a158ab0320b3\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"6207bd5dfe9d56d4\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"f7491408f2ea8b2e\",\"/knowledge-medium/src/utils/panelClearance.js\":\"1aff09528ee8829f\",\"/knowledge-medium/src/utils/panelHistory.js\":\"907d238cce8e5bd1\",\"/knowledge-medium/src/utils/panelLanes.js\":\"b62209be997afa56\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"8497ff0da029ffa5\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"8df1638204889ac9\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"4e11a2bde43e7a4b\",\"/knowledge-medium/src/utils/platform.js\":\"2e6c65492619d9ad\",\"/knowledge-medium/src/utils/pluralize.js\":\"152158d16d53bef5\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"1e1e1b3d23ad587c\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"ddc13687902d1b69\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"24afa85f1f3396cd\",\"/knowledge-medium/src/utils/react.js\":\"c5c65b3c54f0cc6e\",\"/knowledge-medium/src/utils/relativeDate.js\":\"428380fbc11a878f\",\"/knowledge-medium/src/utils/relativeTime.js\":\"9d2e2a3eec0972f1\",\"/knowledge-medium/src/utils/renderScope.js\":\"84166c1ec01198b0\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"63fbefcd0420d7ae\",\"/knowledge-medium/src/utils/routing.js\":\"37b5fa83e43c4593\",\"/knowledge-medium/src/utils/safeMode.js\":\"066c88db0ffaaa60\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"e951db6e96ee4aac\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"8a511d5c07aff32e\",\"/knowledge-medium/src/utils/selection.js\":\"01868ddbc7522a06\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"4bd0e0be2bdef734\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"0fda8b6db19cf790\",\"/knowledge-medium/src/utils/state.js\":\"c50ea58e04a7fba0\",\"/knowledge-medium/src/utils/string.js\":\"ac2580f7454a02d0\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"64387c5fcf1840f8\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"f28378e30630bd7f\",\"/knowledge-medium/src/utils/toast.js\":\"a51e4cbe37bc84e5\",\"/knowledge-medium/src/utils/toggleStore.js\":\"820b115f0e1dc6ef\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"3fa7c77be49cb44d\",\"/knowledge-medium/src/utils/userActivity.js\":\"4fc09fbb31091ae2\",\"/knowledge-medium/src/utils/viewTransition.js\":\"d3dd6613f0eb28da\",\"/knowledge-medium/src/utils/viewport.js\":\"c41622be3867f3a2\",\"/knowledge-medium/src/utils/webLock.js\":\"e35252449d0e6ba1\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"9031ada13d0942fc\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"9832623c1d7bdb91\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"960d47a8a532949f\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"293e9a8cdb138652\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"417b58f0fd0b91c6\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"ab7bdd5335a3945d\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"53fac406c3df67e9\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"f2b1125cee20d21e\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"b0ba959b9f6c1db8\",\"/knowledge-medium/src/vendor/react-dom.js\":\"4b0f663d7886a0db\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"1ec59b65c090a606\",\"/knowledge-medium/src/vendor/react.js\":\"c230fd29315d48bd\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
