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
		buildId: "5a74a140c6d2-db4690ad",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"fdb50b2f51b76087\",\"/knowledge-medium/index.html\":\"fdb50b2f51b76087\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-C_dId685.js\":\"6d59bb7f457a600d\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"1d8d59df6a2cb4c7\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-KquOH8PM.js\":\"e5a5ddba9d8aba46\",\"/knowledge-medium/chunks/FacadeVFS-TX5RCaGe.js\":\"23993934542a6b21\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-ByP-bGiC.js\":\"0aca7ae50a82c7f7\",\"/knowledge-medium/chunks/MemoryVFS-D4JMu0lK.js\":\"ebf953bf245612bc\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-BdLd4DqX.js\":\"4949f81fb33caa9e\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-ICfwYhma.js\":\"fb1a488f1a71710c\",\"/knowledge-medium/chunks/Preview-CNF5eS7U.js\":\"f97a898dd0c1b6a3\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-MtIl8ZD4.js\":\"b069ee52d0104ad1\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BoTMeJI-.js\":\"82c68ba3d8446236\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-BU3tpTmC.js\":\"a7e0934255845e62\",\"/knowledge-medium/chunks/react-BoiO0ptX.js\":\"370a08c3e466aa7f\",\"/knowledge-medium/chunks/react-BvEeWbju.js\":\"3b78bf411b3ce6ec\",\"/knowledge-medium/chunks/react-Cqr9zb7n.js\":\"b10ec4c2fddf91e4\",\"/knowledge-medium/chunks/react-CvCknvMU.js\":\"05554561a1a8c877\",\"/knowledge-medium/chunks/react-DenLFm2z.js\":\"dac87452c97bec6f\",\"/knowledge-medium/chunks/react-DouA3eKp.js\":\"d4245d80733fe042\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-D04gx0NO.js\":\"e6065e32f3a9d966\",\"/knowledge-medium/chunks/react-dom-server.browser.production-WNf-lxwV.js\":\"0bfd18b3e93d38a0\",\"/knowledge-medium/chunks/react-dom-server.edge.production--78E-zP4.js\":\"71d2a0aab807fc35\",\"/knowledge-medium/chunks/react-ouKsV2aq.js\":\"cf39a5310d9e218e\",\"/knowledge-medium/chunks/server.browser-B57GT41o.js\":\"d3b3136559f701a7\",\"/knowledge-medium/chunks/textarea-QGw7Nu38.js\":\"637626b0d023d475\",\"/knowledge-medium/chunks/ui-Cd5PJZlZ.js\":\"2eb5113bc909c421\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"5364c2217f47f1cc\",\"/knowledge-medium/src/appUpdate.js\":\"a7f697a87dd5baa2\",\"/knowledge-medium/src/appVersion.js\":\"6b87d302164d87a6\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"6fcae747922d5ebf\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"f4d4be703315ad58\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"09722d15c88cd33f\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"6321ca1b97d8a788\",\"/knowledge-medium/src/components/BlockComponent.js\":\"3fdef03cab130cb5\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"0c0dd17192946d92\",\"/knowledge-medium/src/components/BlockEditor.js\":\"c153c71822561703\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"ca3102bf26a4c146\",\"/knowledge-medium/src/components/BlockProperties.js\":\"223b9c3350c848a2\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"8ad308e947c4d4be\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"08aae125f0aec04f\",\"/knowledge-medium/src/components/DividerHandle.js\":\"2e570dd39c7ebfe9\",\"/knowledge-medium/src/components/DraftEditor.js\":\"91ca93d2e471340d\",\"/knowledge-medium/src/components/GutterPill.js\":\"7afef407a0fd753a\",\"/knowledge-medium/src/components/Header.js\":\"e4b6528eac063571\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"92de190f4437380a\",\"/knowledge-medium/src/components/Login.js\":\"ce9e938766e5083b\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"0cb8b6ff08589308\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"d86fbef7d070e70c\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"b43e51b2220a7327\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"9cb3060f7fabc2c1\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"94de9dab0dba58b1\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"5710fcc19cc67cca\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"a72baf64e6ed6e1e\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"b387c58ec061cc2b\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"779706be7c544743\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"54d6daa519199f43\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"d17e64442d478f0a\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"0b777b7244d4b99f\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"68ed54b26c6b02e4\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"18e173fdbc3b0f9e\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"7b3e66fbc40cc536\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"3f09e00ce64d89ae\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"0edb5e49cafffa5e\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"7e6fad162d97adca\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"b8b8cbad397ec879\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"f3e54a66d661d07b\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"18f9cba3aee75b12\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"8e809cca0c9a6fe1\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"4432fb010842a747\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"6b20a5a0ec77aa9d\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"9db4295cff853b72\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"a16fb407ef342fde\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"151813fe4c4789f8\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"a4e26213c49eb0a4\",\"/knowledge-medium/src/components/references/CompactReferenceLink.js\":\"6380c79b839de858\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"2fb4407c16719de3\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"7331f5aef8d390cb\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"cc3737cc1b181427\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"eaf5a710f45c8f05\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"1f630b171fa8acc0\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"232f0eeae59a7097\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"eb70367244b9e577\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"3449fe5f1e7db014\",\"/knowledge-medium/src/components/renderer/BlockReadText.js\":\"b46749de0f768891\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"f66989648be9aade\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"adaddc1ed88ea702\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"009a0b348b85eb07\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"4aab9bfa422cff8d\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"e55f23cb727dedd2\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"9fc77411f41b9416\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"13f5a5daa7a7f714\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"d0af3f17ad550843\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"ad58d157558dbca6\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"edec358a71fb8c55\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"407d6b7320937e2a\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"bb1673697a155c29\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"1e304bc1896bd6a6\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"3c3b314ee1eb424f\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"31b53b31c7f6c305\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"368f6d3be9b1fbb7\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"3d706821fdaf4196\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"d81ab432a189f1a7\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"607aaa921b30a92d\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"6352b8bff0cab818\",\"/knowledge-medium/src/components/ui/button.js\":\"03812bde851a5428\",\"/knowledge-medium/src/components/ui/card.js\":\"0ea99d0bdd2defc1\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"7b346d8136437691\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"7c012147759703f7\",\"/knowledge-medium/src/components/ui/command.js\":\"e8b18df4bf5ca1ab\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"1a82a9ba2e066379\",\"/knowledge-medium/src/components/ui/dialog.js\":\"07a9bbe9a1e39552\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"712e5d869e140159\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"055677588c2fd79a\",\"/knowledge-medium/src/components/ui/index.js\":\"cb1683f722baf7e2\",\"/knowledge-medium/src/components/ui/input.js\":\"6f6ab878c0a33a6f\",\"/knowledge-medium/src/components/ui/kbd.js\":\"a107e09c6900197e\",\"/knowledge-medium/src/components/ui/label.js\":\"2ea8f93d87a5ce15\",\"/knowledge-medium/src/components/ui/textarea.js\":\"a1c5ae7546f86c45\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"e1d350e60033d44c\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"54752870c31d94c1\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"19def898fbb7a91e\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"c39a69be16a52582\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"d834b4dd71f158cb\",\"/knowledge-medium/src/components/util/error.js\":\"e9b2748035300c01\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"88b60e788e380562\",\"/knowledge-medium/src/components/util/suspense.js\":\"85eae6536906df09\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"ac6ed698e6f8f63e\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"abf646e1c5eac746\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"4fa275368082167b\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"5fa2f836d553652f\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"f6187f5631f6a429\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"7a891b563c55a1ad\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"f652cde0428a25ed\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"c45fe2b305f73bd1\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"4a23efcea9481a32\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"3e9e1cba789a7cfc\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"4611c50c9d077ab0\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"ea8a277de781b1fd\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"999eee24f71b77c6\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"eb3725b3c87fa736\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"90fa8034d256c9cc\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"1bdba87db175f54a\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"656f34fe8f2a99b7\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"31a5a59c5fde9b22\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"56663d438483daa7\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"fc14fd717eb4930e\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"d6a07b75860dfbd0\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"5a9958004050f4ef\",\"/knowledge-medium/src/context/block.js\":\"13fcf26d2325fcd1\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"4a918e6d44a58c83\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"bec7bc3493850eaa\",\"/knowledge-medium/src/context/repo.js\":\"2321b00e10d2d5b3\",\"/knowledge-medium/src/data/aliasClaim.js\":\"5843215c01f042c4\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"d7572bd12b74a706\",\"/knowledge-medium/src/data/api/blockData.js\":\"7f2e91c0ae532e04\",\"/knowledge-medium/src/data/api/blockType.js\":\"41e71a14d0ab5736\",\"/knowledge-medium/src/data/api/changeScope.js\":\"3f8ff624d6e28499\",\"/knowledge-medium/src/data/api/codecs.js\":\"dc5c6f804f2ff190\",\"/knowledge-medium/src/data/api/derivedData.js\":\"92f8ba50faadd96f\",\"/knowledge-medium/src/data/api/errors.js\":\"a4b135e4040bf94c\",\"/knowledge-medium/src/data/api/events.js\":\"d82942025beafd3f\",\"/knowledge-medium/src/data/api/handle.js\":\"a08a27984859ed42\",\"/knowledge-medium/src/data/api/index.js\":\"75d13637dd06e7df\",\"/knowledge-medium/src/data/api/mutator.js\":\"0f96a0af025c1ace\",\"/knowledge-medium/src/data/api/processor.js\":\"d99e6472dfdaee86\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"f94316658ad469f6\",\"/knowledge-medium/src/data/api/query.js\":\"656c05bfd741c689\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"c7610db408b33d81\",\"/knowledge-medium/src/data/api/schema.js\":\"a08a27984859ed42\",\"/knowledge-medium/src/data/api/tx.js\":\"a08a27984859ed42\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"dcc771f8bfeca407\",\"/knowledge-medium/src/data/api/user.js\":\"39151aa0a316488a\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"ed200cd025bb07f9\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"cdf05a9de7255086\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"47f8895ab73d5e50\",\"/knowledge-medium/src/data/block.js\":\"2da2bd909e2cee4e\",\"/knowledge-medium/src/data/blockCache.js\":\"f3be3d7a6ef7c876\",\"/knowledge-medium/src/data/blockId.js\":\"a0cb2dfa74375b48\",\"/knowledge-medium/src/data/blockLiveness.js\":\"1fa6497fbfff5498\",\"/knowledge-medium/src/data/blockMerge.js\":\"0dce5bbb18d402ab\",\"/knowledge-medium/src/data/blockSchema.js\":\"651a0a7a12f02ede\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"6c095d5fc56a6520\",\"/knowledge-medium/src/data/blockTypes.js\":\"21284ebcd38acad3\",\"/knowledge-medium/src/data/childrenView.js\":\"e593757cd80f2c6f\",\"/knowledge-medium/src/data/clientContext.js\":\"99e37b6a6bcb507d\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"bfdb0ed45b270784\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"53e4cc5265963777\",\"/knowledge-medium/src/data/derivedIds.js\":\"0e97dd442398ac10\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"69fd660c5674bad9\",\"/knowledge-medium/src/data/facetBridge.js\":\"e982f18448a2a613\",\"/knowledge-medium/src/data/facets.js\":\"51f8d9ce162e4833\",\"/knowledge-medium/src/data/globalState.js\":\"653fa1d44a8cbc7c\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"94410794e01682c0\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"f7d19c05e8bab79b\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"48a3599e6116c326\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"872a76fdd2f3d672\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"201ad351447e8655\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"f21e320d76f9a129\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"dcc9a631a8764b0e\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"2fb32fa83c741cca\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"1c1b6e8c9c3abe19\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"b383fff66cab998e\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"45be1614d0d17eda\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"8220510b63cd9e2e\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"f68cecffdb14bb05\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"fa932ac986c0b227\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"6f4d41d1abef9010\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"81603c2df0ffc215\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"9bfb81d7ae38ddcb\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"1147daf1aa505142\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"169f1b7693d17387\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"93fdf74386f0b3d0\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"2f39b752fa8c1224\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"48906d3af6139989\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"5110f393ad19a06b\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"83a780f565b2a3a0\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"6b8523d831163773\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"d4115ecea93ff240\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"622fb3af30b02121\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"493f18f4912c0787\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"08657ca64ef38461\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"4821ba950f993ce5\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"0e24f8110c6d4cc1\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"8ec9ff793c9f9f00\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"48e9517b0fea7330\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"b9d0ede0d162cc53\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"d083596ea7acde42\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"778140d9bdb0f232\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"b2dafbe5b91edb7c\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"04225cb0f87163d8\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"048c9185ed4f539b\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"34e6ba7141caa614\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"20ec91ddb009648a\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"dbdba3a77fc75d6b\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"b67d2bea465ccfdc\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"e6b618281bb3a0d3\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"61ebd359268403be\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"4e04f7ea5772fecf\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"ecb1fb56bbf58172\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"a4b3203c43efd6c4\",\"/knowledge-medium/src/data/invalidation.js\":\"70e3fd1a2b66bf7c\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"e8f6d1bca5e13801\",\"/knowledge-medium/src/data/kernelPage.js\":\"949ac751d69f09e4\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"998e59d1e21d3f9a\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"69b1a60b658a4cd8\",\"/knowledge-medium/src/data/localDbStorage.js\":\"76db867f0289a01c\",\"/knowledge-medium/src/data/localDbVfs.js\":\"9cce463d7bbb2a09\",\"/knowledge-medium/src/data/localSchema.js\":\"bac2e8376828dcee\",\"/knowledge-medium/src/data/maintenance.js\":\"c927ec4e2398f68a\",\"/knowledge-medium/src/data/mergeProperties.js\":\"48265792969ac99f\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"f247a70cc7b70267\",\"/knowledge-medium/src/data/migrationsPage.js\":\"2dc7f1397ce8d251\",\"/knowledge-medium/src/data/mutators.js\":\"c900bb9d4b94adff\",\"/knowledge-medium/src/data/orderKey.js\":\"c89a136ba568af8c\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"1c7d430c89598087\",\"/knowledge-medium/src/data/outlineSurface.js\":\"6ca1cef78037a56d\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"949caf44e74ce7ca\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"6e4479353f45124d\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"b45dafb86fb4f423\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"85c8d6d71ced54db\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"769556af254511b1\",\"/knowledge-medium/src/data/properties.js\":\"d8bda38496ed8568\",\"/knowledge-medium/src/data/propertiesPage.js\":\"f2fe5825dcaf14c9\",\"/knowledge-medium/src/data/propertyChildren.js\":\"9424b9e5b4e00233\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"f8922c746c1eb440\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"06ce2967221d83a8\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"6a60f25690ea62d3\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"9ace199b2bc71df1\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"0663c36c399a3162\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"cb027854112d3c95\",\"/knowledge-medium/src/data/propertySeeds.js\":\"7cc52a596e87205d\",\"/knowledge-medium/src/data/recentsPage.js\":\"377fef5c17ad6931\",\"/knowledge-medium/src/data/refTargetComparableProperty.js\":\"65c18e7db9a1bdea\",\"/knowledge-medium/src/data/referenceBlock.js\":\"085a02b24b57c1f7\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"659164783f107138\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"a32baa38937720ea\",\"/knowledge-medium/src/data/repo.js\":\"0862967354fb057b\",\"/knowledge-medium/src/data/repoProvider.js\":\"52e16314851abc77\",\"/knowledge-medium/src/data/rowProperty.js\":\"1ef19bec3f432894\",\"/knowledge-medium/src/data/searchFilter.js\":\"23940c6f44bcce71\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"534d2a55a0123908\",\"/knowledge-medium/src/data/stateBlocks.js\":\"06f0ab5b18f82e3f\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"4dcb7a3ed5f128bd\",\"/knowledge-medium/src/data/structuralInsert.js\":\"ee53582c130aab1a\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"bab32ebd2e3e5917\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"38c32d624bd887a1\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"00d6a48bd50a7686\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"dbd71942dde92ad4\",\"/knowledge-medium/src/data/targets.js\":\"af513cb1f0dec24a\",\"/knowledge-medium/src/data/typeColors.js\":\"c166fdf5c9fbc6f2\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"412ed565fb965b61\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"1b5cc80d61c7702b\",\"/knowledge-medium/src/data/typeExtraction.js\":\"40265a96551f8add\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"1997ab772cc59b26\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"1eb5c78006e82543\",\"/knowledge-medium/src/data/typeSeeds.js\":\"f953633cbc3b6f3c\",\"/knowledge-medium/src/data/typeTagger.js\":\"e19f9506ab1316e2\",\"/knowledge-medium/src/data/typedRecords.js\":\"76223dd1fad815c8\",\"/knowledge-medium/src/data/typesPage.js\":\"0b21c232d95da3d7\",\"/knowledge-medium/src/data/userPrefs.js\":\"e679a13de76326be\",\"/knowledge-medium/src/data/userSchemasService.js\":\"7c1dfd6950ff7449\",\"/knowledge-medium/src/data/userTypesService.js\":\"d4b14b1c929f4792\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"a7425f55b11d5157\",\"/knowledge-medium/src/data/visibleChildren.js\":\"ade8dd781bc01822\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"810514c34ce173dd\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"c63cb1ee1d2defa6\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"11dff24d0607ed88\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"d9e52c1c412d907d\",\"/knowledge-medium/src/data/workspaces.js\":\"af2793ae99f342d2\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"45fafe60a359fdee\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"af36395d90961496\",\"/knowledge-medium/src/editor/atTrigger.js\":\"80d9d72e71f0b7ee\",\"/knowledge-medium/src/editor/autocomplete.js\":\"908f939614695f72\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"9ba246a2938ccc52\",\"/knowledge-medium/src/editor/contentFlush.js\":\"9039f192bd409def\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"e0f2ad3f2d71c508\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"97a1fe96600ef84c\",\"/knowledge-medium/src/editor/insertImage.js\":\"db303605ff253f2b\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"934635ced1ed31ff\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"ae1ce26d824f7d27\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"551f1c563d350444\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"8c42cffdd713404f\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"81ebede23c9e4f87\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"66127f6f947c424d\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"d4c666956a5f7de7\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"828b86244f88708d\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"a5946ed96c846c2e\",\"/knowledge-medium/src/extensions/appRuntimeController.js\":\"19d041ee4bac35a9\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"a235e5c8d5b7e81a\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"a8d5d85481a2c208\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"a774f6fa7491197f\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"e515e1af5b5714fa\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"8128ad2b2ef401c1\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"3d4c049973b5cbec\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"ad7fad41c7401e22\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"efd251e16057554b\",\"/knowledge-medium/src/extensions/core.js\":\"1f58ab4260ff7e84\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"9887032fe69ebc2c\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"161d160e7432028b\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"63209a0f6e2d3d65\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"94b31c9a5999190d\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"c8d3419741eb8732\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"6861b97102647cd6\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"4fb5a355bf5b5b3d\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"21f56543bbf6a459\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"159feacdc84f5dcc\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"0e0beda29a30287c\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"c4413b5413ef455f\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"b34060492a9e50bb\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"eafe30caf77e7092\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"a7515187dad00537\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"97e869b69915978b\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"4faeeebbb3434340\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"d3bd1681fa6d73e9\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"cd9d9a6f782b37b3\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"b02090370209c902\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"67d574be486b098f\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"40a8b2629d79eb53\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"630db405bb86b71a\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"7b59eda97c5898d3\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"9fcf881813d5ac18\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"6e02835ef185403c\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"3d1dda5e19a90760\",\"/knowledge-medium/src/facets/facet.js\":\"d416c95cb911eeaa\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"465706e4ad17eade\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"27f10ba4d7b67e50\",\"/knowledge-medium/src/facets/togglable.js\":\"ef87fd157c9e6d95\",\"/knowledge-medium/src/facets/variantFacet.js\":\"d97383bdfce3e55c\",\"/knowledge-medium/src/facets/verbFacet.js\":\"cde3ae08e6f507df\",\"/knowledge-medium/src/hooks/block.js\":\"2e4b396529997077\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"0a7984bfddccffac\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"55d8b2bf86813bd3\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"c10da851cb1bb4a4\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"7f3638c364fb54b5\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"e1c68b5a0b31c9c7\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"a06f3febe73e0ef2\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"00cb2ab872294536\",\"/knowledge-medium/src/hooks/useFacetValue.js\":\"fa6dbdff6dd622e1\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"70ff2bf0cfd264db\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"ab1b9767622d551d\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"b077475861815767\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"f813f96fb62369a4\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"e92bbb266b57ffee\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"63b3c2b044e4ffe6\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"23bf794f612135e9\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"9225f38cfe16ddf0\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"412e6e23f437a4be\",\"/knowledge-medium/src/lib/utils.js\":\"02762a06dba9b985\",\"/knowledge-medium/src/main.js\":\"539d8edd5260880b\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"ddf323c455a16d78\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"f488dbeb84df3220\",\"/knowledge-medium/src/markdown/context.js\":\"20d4338a1a1c864d\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"6978d83457747f4d\",\"/knowledge-medium/src/markdown/extensions.js\":\"0b41b6f6f6550262\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"73665762b1f7214e\",\"/knowledge-medium/src/minimal-editor.js\":\"21aeb96fef4441ba\",\"/knowledge-medium/src/paste/armedCut.js\":\"e6149a00755ca4f0\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"06ebe452ca81c5e0\",\"/knowledge-medium/src/paste/clipboard.js\":\"e6c34be7dd9dbe12\",\"/knowledge-medium/src/paste/decision.js\":\"5c08a7f823d212de\",\"/knowledge-medium/src/paste/operations.js\":\"4dcb7507ba52a1d3\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"4a60d11176acace0\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"e5a81099c94cedcd\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"c6f258fb55abbdcc\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"66e3363d6671983d\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"7740c2a5be7987b6\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"2cac6dc835e474c4\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"796b6971cd8ee8eb\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"44043fda0ee62e48\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"ae2c0863c00ba3e0\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"c99283bca93cfe6b\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"fbbbfb4aa1d11f62\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"59239c4c7a825021\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"1e62b0f24ffe66b4\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"a750e72aede1897b\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"7c12e187592c63c5\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"d922ee1c67284ab0\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"9c0b42b4c177ea58\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"9f90c01839a07919\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"bb9e9b4c2530b63d\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"59d4c68275e40a65\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"781773032485eaba\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"c991371929fba031\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"adb8d58281919ced\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"4482735a6172166b\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"286c7d3973e971a3\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"1331baa281efb05b\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"234ef4dc03b66c27\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"4138791d3c18dca1\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"59d69377ec69a850\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"3781706be2748ef1\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"d92f30cb0a4bb885\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"73607bf11d0cfa18\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"4a1c5b4037d4a1db\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"47ca6f72bf0fbe09\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"8ee9e4e05ce573c0\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"7076f8cdb5b6a7f2\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"06a066362bebd610\",\"/knowledge-medium/src/plugins/agent-runtime/dayPropertyInputs.js\":\"2053b463c5ea487f\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"2e5047358a001148\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"aa4f955c7cfacfd8\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"51529190f19040f2\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"d4f8e6463bccf0dc\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"4fd8f396ca40558e\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"35bf547012f4c8dd\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"3703cc68c2045aa1\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"eb6e1382159d76c6\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"c5ed6084276ff124\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"41699b58d0acab1a\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"949c45d84493b910\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"49d05daca1177968\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"10d9afba8938a5f1\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"e70edfa78b5f6384\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"00a11ca053218afd\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"5c93dca65b7985ac\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"8e68476dfc6e8cb6\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"b721af6820b3dd11\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"744ba678848224d4\",\"/knowledge-medium/src/plugins/alias/index.js\":\"21b59e6e4ad73bce\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"40029325d0473cb4\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"c3c57b9e6547ad49\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"ace62555cbd1d182\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"742d3099583441c4\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"2e7d2ac884c43ae0\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"35cf65169c96077f\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"5e1f527779ef5782\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"95155acb91c26a40\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"e89401d04255cf37\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"d7cf1f90ba50b511\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"a9080e54ce6cb950\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"231bf0415bcce2c8\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"13ae7ebc4aa4dfa6\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"bc245e658c32b7a7\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"dc647203ba52cd48\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"af16b300015018c8\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"d778faae7b9567ce\",\"/knowledge-medium/src/plugins/annotations/marginAnchorLinks.js\":\"6361ea22b7470f4f\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"6206978de1da1d79\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"f3deaf0a9568d9dc\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"e2140ec1c1e9a611\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"fe632391fbeb0b11\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"73a2d0e0317e3a93\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"fcea032160c0a0e8\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"af66ac8e6f7398b4\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"2da71b28083033c6\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"c1e5d073f99823d9\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"3db97ef4f4f0893f\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"794ef9406a2398bd\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"3a66dd6fd0871e18\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"081c0c1fcc7ed300\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"f1da248f3ace4cee\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"836dc1507b8f9a75\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"1d96b53ee43bcfec\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"63f150c90d6f00d6\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"b4fa2d479569bc6f\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"569d9dac14f32d43\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"0298823dd5983068\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"1501842dbecf5cd7\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"d0fe199463263156\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"657e0e869ef7e68b\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"19913be25e33476d\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"fac2e747ca66b1b1\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"e61256c6acac834a\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"5596bade3ce6c9c0\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"9836e088738daea9\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"a347dcaeea442ee8\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"c011e74434d92c36\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"f44908ef4b3c91e1\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"132df427b8a5b83c\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"62ec237f533646e9\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"7c7a83929be6c371\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"43b9da1b19025b1a\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"13afc7c1c8e3105b\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"952a6fa1ea89f765\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"7a28f940231954b0\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"a633fa4a0228321c\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"67f9282c3b10175f\",\"/knowledge-medium/src/plugins/attachments/browserMedia.js\":\"f511651f8d01ab8c\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"4f62b1b44a187104\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"0c48e32f113f1bf6\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"3538bc65b427b497\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"59ffa9022c713496\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"e166989542b09d4b\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"4797625edbcb8dbe\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"be6e6f0f28eab81e\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"02cef100971603f0\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"4cba9773fc84aad7\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"1cecf3c481f3fb23\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"aa2579ca02141d14\",\"/knowledge-medium/src/plugins/attachments/mediaLanes.js\":\"2dbbb27ebd94b970\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"20f6b319ad6ee8c8\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"3c6b1bed04166672\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"74bf761b842db625\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"028792124d112803\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"72a7220181cc5136\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"0617dd9aefed1631\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"b0e6a8d68b519933\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"37f0ee17d7bb9d9a\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"abbe45519daa7bab\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"23c9cb1162e058de\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"0769226faaba4c67\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"fe921e49ddb4dbe9\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"4e79226b5426973b\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"e5bdcfdcc27eece2\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"cde6e336cbd1d8fe\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"b69cea6bea64b2f1\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"f35f03d344225dfb\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"1dbdff4971648b27\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"d57785a68437f8b4\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"b7a7e254f5530aa2\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"fb2d1db9270c0a74\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"ed503ea600e5bf5a\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"9f38660f2df693bd\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"579e61efaa9f4a90\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"c22cf87cc6069ba6\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"cc7439ce0a2c4a7c\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"a88c9706caf2fde0\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"40d0ef2ea139ea2e\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"db5b11d1a21bd556\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"8f06d946998c279f\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"3d32a2fb0d246875\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"74900b1244f737c3\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"686ab24b8418d61b\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"1579980017f015de\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"f743f230bef546ae\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"639efb5f045070e8\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"1fab5b6f5b0bebba\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"27c081a3ad9f58da\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"662e7897d714d2a1\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"e6abd416be885be3\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"a5614a658398796e\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"93127ddbef21792a\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"423ecd8d4ff0a13f\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"b48ab7c759c51ced\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"41fc1b6f3d2868b2\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"6671ecd01a446901\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"2553a8f381072902\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"e718e4ae3357458f\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"2f1844d0ce53cc22\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"ca1bc867c87090a7\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"1d8c4275240b7f46\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"2d14a55ca4e8ceae\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"2704e1fa26490a10\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"2ee1cb63120bf763\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"4babf681349c735d\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"04fac32df661ea4f\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"7edd59ca9e1869b9\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"8cc07c1e9d81b464\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"23748a3dc48dc975\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"d022a4e046cc1250\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"cd63e0832b70cf61\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"17a5cbc4704aabae\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"8fdc7cb5b34e1d3f\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"3fc858b382eac9ef\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"4b0f5fe715bc0a04\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"00c68367bbcce179\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"68007418cded7160\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"0b549e96d5e69352\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"0aab1b1ee5346827\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"f56f12224a5f587c\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"87830a1f904b7254\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"6010256f85a2875c\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"3a59d9e2f071fb97\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"60aaf3719df4d0c6\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"dc62b6c46d39b5d3\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"ca5ee3809d1e0b31\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"b02750c482498e79\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"529858cdd6ff0c9b\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"49dfa3b8761248c3\",\"/knowledge-medium/src/plugins/character-counter/subtree.js\":\"8ab259d01924b84b\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"527224b3ff1ed735\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"c7a962f1977085bf\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"4a4f9470e1ca11b7\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"d0c7290f46d4d27b\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"0de2440e63ca358b\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"a8eeb22c25172acc\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"6349412f2c415aad\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"b4b489eaf8bf3fac\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"f2d9dc5821c58d6c\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"e14fe4c293b51073\",\"/knowledge-medium/src/plugins/contributors/ProfilePicture.js\":\"cafbabc4afd0c99b\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"2511cfd245a3621b\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"6d921ee91d6eba2f\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"7ccb34a314b65ffa\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"794bab4570fb61f9\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"26292de063725501\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"9dbffde999783ccd\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"0709c90375c0fe74\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"a0fc04acaab3de6a\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"f174f391fc827777\",\"/knowledge-medium/src/plugins/contributors/useCommentAuthor.js\":\"49760d5441fed52e\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"c0f7a22061be948b\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"7bbe30a5cb2a60ca\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"48e9e8f35010968a\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"2b3a6581998486cd\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"c12a8f10d2253409\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"edbecb9a8b297065\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"9e41b361af4a0e30\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"27795bb2645d2a7e\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"ab8b20ca438bf3cc\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"76b5e712a0eb117d\",\"/knowledge-medium/src/plugins/daily-notes/DayPropertyControl.js\":\"ba47c34e3f1e4bde\",\"/knowledge-medium/src/plugins/daily-notes/DayValueReferenceControl.js\":\"756d870d2e367e0d\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"91716ea159569dc5\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"258c3adce26bc8cf\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"8fe031c1a921c03c\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"d37051d85323693f\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"f13ee89d992ce7ae\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"19e072b1c9e97e7b\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"daeb33605a01096e\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"651bb1294f5b50dd\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"cb418d1bf5cca27d\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"1e3a9a6f3097ea9c\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"578e5c8c9bcfb247\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"ed0a1487e169bfff\",\"/knowledge-medium/src/plugins/daily-notes/dayProperty.js\":\"5397af84d83cb9ab\",\"/knowledge-medium/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"c521ed40b65ca8d1\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"55e898f276355da0\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"0ef69d3a5cc389ba\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"93ec368e919741eb\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"e606fb9f02d646a8\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"e26e9237b7bf35a3\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"ecab0278e57b1fe4\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"30f9babcee347f03\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"09ebd99fa811df1b\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"466799baa0e5a874\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"95337efb1c6d0e14\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"d590114c6de44bf1\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"85bfdde54392673f\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"6602e9585176e8a4\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"adc032c703d84c84\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"5e675cc8c95239c2\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"e98d7e0bd5f21e03\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"ec599308a138f076\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"c180f84bc01f4055\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"8d97021b5a8af412\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"d7c520e35554a3c8\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"f59e633f20bb01a6\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"99fae0f5b5456c4c\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"85c862e1de1ec9ac\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"ca68240cbb97cbc1\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"e44ad0a2e7f56ba3\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"449bb379e268501a\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"c666f8cc1188b0fa\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"f27ab11414dd4abe\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"d8da49fe11e50732\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"b1cc81cd3a19d33d\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"cae1d2ee1d55ce93\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"28c7f30a8717f4c3\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"4321a7f86a6f686a\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"14696b53be58c842\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"45f3c69cb5f4339a\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"47454b6ca054711a\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"b2400cbf2800b29b\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"14bf609c1c7f778b\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"249102c982d6ae8b\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"2d5d82b3d8238995\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"55adbb3a72351d5c\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"1da53c0199051673\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"05cee6390c1b9235\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"a4481e816e4327ad\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"becde1763b6bdb02\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"d650430d4fd26c40\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"ffa7cefd331a0a5e\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"39b54ba854530a36\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"aa193b316dde75d5\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"845fd10b2fc47d4b\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"4931a2016930a301\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"410c3b9c36f61fd4\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"9491fa164f2c4f22\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"b45d6671575b4f90\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"9756f6c8a1185514\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"764e01f6eeeae2d1\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"36d2ee32c982863f\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"97f02010e29d13dc\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"4615b75e9168b847\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"59272e31bc6a53a5\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"8bdefa664d0562ca\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"0f78a819a88e35e2\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"bf9d7f6aa37f04ee\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"4c6ceb813b222308\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"df176885a87310e2\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"81b37c84c50e5ac6\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"fc2a58f7e781831b\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"1e0bb019154dca87\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"70670d225eaeb330\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"8952695998cb3cf6\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"603b21caf23d9ab2\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"376a217b053c2f20\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"c2c83be0f0ebef05\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"0fe0b035b9756f4f\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"593f3bf64cee9ac8\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"7f3b2e372ab85b47\",\"/knowledge-medium/src/plugins/geo/index.js\":\"209c9e02de0ab93f\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"ccaa2525486dade1\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"859926904f58f45c\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"365aa1988af86a02\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"486edc95628aac65\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"7b96d02527b65eee\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"5656cb40b8c5b905\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"c46fb39905d0306b\",\"/knowledge-medium/src/plugins/geo/query.js\":\"fa748882b70f83ec\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"ceedee4d72e77a88\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"bac1dceefc15d64b\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"a979ee0080c22856\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"8790c8947144b891\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"b2131cbcd3ca846d\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"e04b96d0bbcdcbba\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"28232be87f28dac3\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"56d05e414da4e15d\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"02ee10e2bd0dfe02\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"b8bad78a8fca3f88\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"28d3c6a8067fc40b\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"b37908b4d98cc163\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"60cd1fde80907ea2\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"8386bfe6446b179e\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"b645444468ae4e7b\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"2104c2fbbfced1c2\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"8935b8e2fede1681\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"58e239b18c76bae6\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"7649f3d7dab07556\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"932107a79ef18793\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"02df1d152186b754\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"9ec56b7598ff8350\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"fb1b535c54d1e45d\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"fef290001cd93978\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"127bcfc741f9dda7\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"772586bc16ae219f\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"3f88bf851039940e\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"4b51fbe9265ab520\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"b73071f7100b6f11\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"dc207c74bffaa80c\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"1d25395d0cc96b3d\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"944789c74ee60d25\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"61f23857cd3ba2c8\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"14b07742e63cf494\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"6622d7926d2270c6\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"eb9d383eee5621f5\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"203791afd4a9b344\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"8882313e47b3b4a0\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"edf40b7a57124228\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"7e240fd5222913d5\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"814e2cb995ff848b\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"e20370704acb5976\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"b48892a01eddcce5\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"7c649f5599d40960\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"afe647866d862185\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"6186b48e2ef5c990\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"905856e9f8a0ae4a\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"b47393e7c3c85cd6\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"ac99710fe0a7f56a\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"9ff07ea0bf6a322a\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"1aa0069ba4dce782\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"6d5f94bda471efa4\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"7e58b3f4041f44bd\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"0cd148ca1417f375\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"19bb76efb5e1eba8\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"96df22c5d32ef0ab\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"e7e39a5b31bcdaf6\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"97c9252f6bc9806d\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"cdf4a1f23aad61a4\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"7d0d548c8ef6c10d\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"376b63f85fcebdcb\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"a980bbc2df61ddb3\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"3737395d85fb790c\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"3ab14fedf77d339f\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"4daa5a6348f460f3\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"8c2514fb49bf34f6\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"15e8728de7a62884\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"ff32ae16c95a5eef\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"a5690b967e2a0a6d\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"fefbfb2278ba3550\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"e4b40083dee3ec45\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"df9cee9a18aee1af\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"c2d9a0379324707e\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"5065ca4d83d11f8d\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"e63f41b59272c910\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"41b8e7cdfb225e5a\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"748825f34bcec859\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"dea66175c793d899\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"cfdbe342f5476592\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"fed5eccf9e65358a\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"28d4e626b4151c53\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"64f7db6b18148511\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"8869d76831685328\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"cd9241c5b14a97ce\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"9158f51ee651b9d5\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"9a1fd9fd606d1c1b\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"553ea3a188cc9a77\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"7b25dace78b2d69d\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"ab5a8d0987fb1fa3\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"d8a9579edaae481c\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"7c8404b66ad49221\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"82fa433fcb78ba39\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"0c4913b9a266d34c\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"42145af679f0963a\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"2f24d50ec535c682\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"cac71d560e9a6ac7\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"2c5cef64df37b460\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"9e9bce5dc4a502c2\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"11e81e2efe2715d0\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"8c256f809d91dc0c\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"52d4716b316e4015\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"97487f23213f3a28\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"f2ae5bea7946200b\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"b57b4ce0f1c3e049\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"21b7dd7b7c3239da\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"6c902b5d9673b225\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"debb2be65ace754c\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"d3c3b92c0b41fcbc\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"280f33ee6ea62c16\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"06a06efc8f9c0773\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"33b3bb2447a5aeae\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"19aa27ddb731c49e\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"967dc6f944b64294\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"0719d588adb00398\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"8285ed776360b9e4\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"790a9017d2cf999e\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"59c1e2fd75e3f985\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"bd8a6c7e29cdac17\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"00dcf66e2bb98498\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"67a4a1da7246cda8\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"2589bcd8c538c9e4\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"5f08c0181d4f304c\",\"/knowledge-medium/src/plugins/recents/index.js\":\"58447dbd39d6a5b3\",\"/knowledge-medium/src/plugins/recents/target.js\":\"3dbeb70cb8f97974\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"227007d58262475d\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"100b4e7579f719bb\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"e9a6324c4ca131a8\",\"/knowledge-medium/src/plugins/references/index.js\":\"9fb3f0ef1358e638\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"dc8831c856acef12\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"a90dbe804f34ad08\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"aacc226c4a93e193\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"1f65368fb8537a4e\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"f668d6a962d4961c\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"0de8d56e6c5f28c0\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"5b6c5f960c7aa0f8\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"953b877dade7dfbf\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"355fd731341c9eb8\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"498a914285503615\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"69f2b4768d9872fc\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"d04e04fce4ba751b\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"95d9c9db22b0b48d\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"714bf0901a827926\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"8d48ad6a4c7fe17f\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"a269ed43181e1957\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"717ff4cdb2d8c6a2\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"cb12a5cb99bdd2f2\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"255cf5913301b4e4\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"f0e797e9fc68451a\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"b1ef29a9546a208a\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"b2f0ff8f61be205b\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"72106f2c63c2eecc\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"f71df92a6fad18ea\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"9b4cd0521fafcd1a\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"186ac251a20b26be\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"f5e4ee04349953c6\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"dfeb03ae972af885\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"71a450cd8d484710\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"f084fa73f1953c29\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"baf619294695445f\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"ad5c4536b185bd98\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"73ee89c928fe0aa0\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"d2e3a79cf83fbbda\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"c47c7eaaa5e4e93a\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"d2de3f7a54c5adf5\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"752fb98eb4bf4a2b\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"ea18bfba3c519d02\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"75d4f024f4ad8abe\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"a6f3a62e5bba7fbb\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"704ead7327d67ee3\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"e8168143b98a057a\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"84ed2ff9b0554326\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"6f9760c13eafe1f0\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"2ee421eb3a1d438a\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"2ae8a825809b5344\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"09e48d3e150fa8fa\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"839ca5ec4a8bc6bb\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"17c8b078abf2e215\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"d0d50e927dcf0e69\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"b5c5e74190fe37fd\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"ff712d1c90412672\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"59df654d4dc552aa\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"7f2df203896e2014\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"a543fbd85d1638da\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"65737c9671756787\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"532230834a5ffd71\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"6b9e40200ffbd07c\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"3a6ca7be8f6aaff9\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"93a921d68be4e64e\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"5849b0f38ed723e9\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"b9ea17d18114346a\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"e11af3cd06f2d732\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"fd93d9ce1868c9ed\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"8a70ff1eb1a18a74\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"8897feddb71a28aa\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"fce0d5b444a806b3\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"e5c481c3d1bb2dad\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"b2cad199dfce99f2\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"6a9b87ab403df42b\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"4d8c4b6a8a78215c\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"5e306cb26fb77c20\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"5513b379e5075ffd\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"b7e49e4a1d574ac4\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"f87e3e040b10438e\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"c72689927cd1efe4\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"60bb912d628223b9\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"7f1d7d4ad6221dae\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"0896cda36353e0ac\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"da7637158c7f96c1\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"98e076544023aeba\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"0b37db03fb02c783\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"2f6ca5e559c831ab\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"27329f8d0961c019\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"6f1ccb97f0dd3b46\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"38810069dbb1b5b5\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"f729ab18d6964ead\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"8983ba4e4c6dd11e\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"af7c6c6b8131b13d\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"7c1dfbd2f52e84e5\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"f984653541ffb16d\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"d6c7178c0c62a0fe\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"289e824d58af2ae9\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"541111ad6a40e3b2\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"071133d3c9db4027\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"1b3138d6e37861bf\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"280e3debd86b1ba7\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"0f7d881667626a4f\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"fc3f3e6e8ed1d575\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"94db8a609652df40\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"b0d891e8d1816e6c\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"a434746a64d4608e\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"30a136e1934b59e5\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"192d759bc28394cf\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"7746ac692851a8a4\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"14ee489825ac5671\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"5016f948b79b0804\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"ac2dbc1cf43b4262\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"d6ab76d02f9197ed\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"df97c775358b7732\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"4c22e716a1b86cc1\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"6daca32b17cc744f\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"9741812b38092690\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"0b73086ff4a0db09\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"fc3dd251c1deea47\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"fac9c595a6d493a9\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"980804847bd83c5e\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"f97f314cdbd2c6cd\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"e6efe2c1934ab235\",\"/knowledge-medium/src/plugins/tables/childrenViews.js\":\"dc3c97c9232f7372\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"a06c29ff73bb134a\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"07632929235b87ed\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"d4b755075c88dda1\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"ba9f28a579904ddb\",\"/knowledge-medium/src/plugins/tables/index.js\":\"498698b6e31be4dc\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"4428b8ef815f5e66\",\"/knowledge-medium/src/plugins/tables/model.js\":\"24cde5ef08792445\",\"/knowledge-medium/src/plugins/tables/query/QueryText.js\":\"2546272ae60a38d0\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"8add6becaf33f4fa\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"bc7ad81e578e99ab\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"efcc4b5cbe973809\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"0147dd205ce0d823\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"7ec599bdfce794f4\",\"/knowledge-medium/src/plugins/tables/query/registrations.js\":\"c84f95e45beb5551\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"42edfbdd3244606d\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"84c4d0881f89498b\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"f909000d3dfa6d96\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"80180e1fd6cf45c9\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"029b10a48d068672\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"f7d610f59f3efd2a\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"df2a01d7a2d86b31\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"753a19377b52305c\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"303b221f2ed1f3fc\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"12dab7a36dee913c\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"d69dab0a455a5361\",\"/knowledge-medium/src/plugins/todo/index.js\":\"42d7b190aa819520\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"6f972577ece1e425\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"ca926b0961bab127\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"09d9e12be2d8cdfd\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"2f7b0686b7298360\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"2ea60b05a8c97ebb\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"37ce3e67d2814588\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"30153662485259f4\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"5c5b1a9605677803\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"928015e44e546ef1\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"f0a65e0f667e7ec2\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"7232927751ed5819\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"88c0918ef13715c3\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"016ddb14c33eb249\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"99015033d7c687e3\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"f6ff626161de4c28\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"a9424a76257c5d51\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"f7224d4288a13dbb\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"5706234e9b0da2f7\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"01b4a6a78a1fe1b4\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"be1abcd7fe6d85fd\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"987bd6ba4743b8f6\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"f4729e22f080c98d\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"218f6d99b3019101\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"93134c3bf21b3cff\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"7f3fb51d53b28474\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"4d0ca127a418978d\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"d11b7fead4004ef6\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"34665a12b260c05c\",\"/knowledge-medium/src/registerServiceWorker.js\":\"53795f0dccfff3e9\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"100fc19e2feb7661\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"91db054b7ba933d3\",\"/knowledge-medium/src/services/authStorage.js\":\"ab0562b7aead6e47\",\"/knowledge-medium/src/services/powersync.js\":\"ee8c4e948a670fa9\",\"/knowledge-medium/src/services/supabase.js\":\"faefa3e6390df79c\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"447eb4705908f942\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"53916819900e2c7e\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"32f64925160795d9\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"ea95dfd662684ee0\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"dfd7fda13b6b2e31\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"4fa14c5e78bcfc39\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"a35e90e44fb077b4\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"7a9a674f47abfbef\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"253740594577c5de\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"c053d8e7921edc98\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"7d6e8f56390a6d7f\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"f5ce84a64e7e59e5\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"3a94ca9d2caf2d6f\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"b788a7079f84d05d\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"97b52c96efa807b4\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"97e3f270a55062f4\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"49de8519fcdf319c\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"e549b5bd2d5342f5\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"2e25e683519e3a6c\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"9c8e9de2592374d8\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"b8e93dc725dc23f3\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"30c1c173b331583c\",\"/knowledge-medium/src/shortcuts/types.js\":\"dcac37829e92559e\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"b72dca881c429249\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"a62220a1f9b08295\",\"/knowledge-medium/src/shortcuts/utils.js\":\"272f17a6a5dcb4b7\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"907759a45968a91c\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"a419fb704346e3d3\",\"/knowledge-medium/src/sync/byteTransform.js\":\"7a2e994ebca7b2cc\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"e83beb0e11b9fa07\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"4cf009e271768bcc\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"eb0b05bde199d82f\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"b4036967b08b5a0d\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"92ed0a2e0ddb5dfd\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"33bdf4b598f81c96\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"5535f013aeb05aab\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"a78ca25051bddf18\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"87d7d2e1d35076b7\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"e98410474b75583b\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"55ca4c6cdd874348\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"ae7d6f89bdaa1300\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"7ad076a7b06e7a4f\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"51a26612d0ae8895\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"d58cd1872a8c5562\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"7f2df2ec1d6998b6\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"b2ad59d44111d687\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"cf942623f72fb6a6\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"79f1ea883d23777d\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"507dfdcc26489403\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"8d290a4f2ab5dc05\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"9b21a3ba9c450f94\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"789bd6e296532cee\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"51fef28a93274119\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"e9e3c38bf542d5df\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"5e4914c328ab1ca9\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"dee76da04fbfd9c9\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"b2587ad8c6e5d4c4\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"4d84e98a75c819d6\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"e6abd1114e2fd8ee\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"b924ba1c25166ee5\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"1be8ea663106a3b7\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"d08a507d073f9b93\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"435628c51231d552\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"80f0ef8ed261c8a2\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"2f73f5c43b1a3dbc\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"9f9d6dbb7a03454b\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"6c7908f59cfa6324\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"772179be4513f319\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"d512ff1a6c610b42\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"4fe09971e0b88cbd\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"1bfcbb51558929d3\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"d3d4fd43d3d43b74\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"2ff5d6c06b5317fa\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"e9f4ca1c9421be86\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"6950343fb7bc00a1\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"3e801722f094c4f7\",\"/knowledge-medium/src/sync/transform.js\":\"f31b7d291546a54f\",\"/knowledge-medium/src/themeBootDefaults.js\":\"ac1725cd129c27bc\",\"/knowledge-medium/src/types.js\":\"f2837cc775374ca2\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"46b4593012b6c289\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"af203d665e29a2a9\",\"/knowledge-medium/src/utils/array.js\":\"8ea796e0b080bd34\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"1d46980e08182a14\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"cd38ee132df10e2d\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"2321d8f08706b50d\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"70c1820de11f1dd7\",\"/knowledge-medium/src/utils/callbackSet.js\":\"286b4334239a969d\",\"/knowledge-medium/src/utils/clientId.js\":\"3205eab083f2f573\",\"/knowledge-medium/src/utils/codemirror.js\":\"6a9a387b3152cff2\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"6913a0373aabd2bf\",\"/knowledge-medium/src/utils/copy.js\":\"19ca5951f7307470\",\"/knowledge-medium/src/utils/dailyPage.js\":\"b8a561fccc87d07c\",\"/knowledge-medium/src/utils/dbForensics.js\":\"cfb79a79fc56a70d\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"30a18684a81f1617\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"e8ee4ff95591da12\",\"/knowledge-medium/src/utils/dialogs.js\":\"8550b3987573dfd7\",\"/knowledge-medium/src/utils/dom.js\":\"7507bfab0d7aea43\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"76ec82a5f8418416\",\"/knowledge-medium/src/utils/drawnWalk.js\":\"082f1064ff3a0d88\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"2d52a780bdbd0466\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"ae352aecb9c01b27\",\"/knowledge-medium/src/utils/flipSlide.js\":\"cdf9448aba10ddc4\",\"/knowledge-medium/src/utils/fnv1a.js\":\"825a3b9594e5dd1a\",\"/knowledge-medium/src/utils/formatBytes.js\":\"4e456f30e7ebcf84\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"e3ed1f22605f8cc0\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"2367b07af87676f6\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"d76f54953fd589c9\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"81124d2b7b512409\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"574aadc5e5c4a113\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"30b433f5cabcb15a\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"86d16a36b191cb2a\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"e2a95b1d02f87932\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"4a78842a7ef8d374\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"e19fa56f94ab677d\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"3ce51e3fdbfb3a61\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"5c8bf1cceb215a5a\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"04d537a43cbaa935\",\"/knowledge-medium/src/utils/markdownParser.js\":\"9566f451916d1e14\",\"/knowledge-medium/src/utils/memoize.js\":\"058d31df705ea740\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"31b26691edbb2c7c\",\"/knowledge-medium/src/utils/nameList.js\":\"bb9c58878d8ab550\",\"/knowledge-medium/src/utils/navigation.js\":\"7c929042930db376\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"c080174592bc2068\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"8eb10448c8ac045a\",\"/knowledge-medium/src/utils/panelClearance.js\":\"3298098a8dc015a4\",\"/knowledge-medium/src/utils/panelHistory.js\":\"ab06620a49d1677d\",\"/knowledge-medium/src/utils/panelLanes.js\":\"b5588ab0197d345e\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"e5fb9848a8b24c87\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"95f1307b39d3dfab\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"0dfe3d8a087a946f\",\"/knowledge-medium/src/utils/platform.js\":\"536d07f7bfe35dd0\",\"/knowledge-medium/src/utils/pluralize.js\":\"cba91646ee2dc487\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"9fa0731f464d39c6\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"8d2f9d67e2a75902\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"ab9747c1ea97c121\",\"/knowledge-medium/src/utils/react.js\":\"92565232d8098de5\",\"/knowledge-medium/src/utils/relativeDate.js\":\"146d7993a38be94c\",\"/knowledge-medium/src/utils/relativeTime.js\":\"f42ea81de52ba7a1\",\"/knowledge-medium/src/utils/renderScope.js\":\"9decfd762fac6bdb\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"557ed729081affc5\",\"/knowledge-medium/src/utils/routing.js\":\"b3617a24fb64425d\",\"/knowledge-medium/src/utils/safeMode.js\":\"d4a1054437c0a3e9\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"2fe39f533d8832e3\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"292fd0194286fab0\",\"/knowledge-medium/src/utils/selection.js\":\"b43959ad09266a69\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"5d2bedec3285229d\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"ed1870bcc2d30697\",\"/knowledge-medium/src/utils/state.js\":\"566d7574dcaaf9b8\",\"/knowledge-medium/src/utils/string.js\":\"dd8126b163163805\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"4491a7b4d0c926a2\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"42880a71a637fc5f\",\"/knowledge-medium/src/utils/toast.js\":\"9a88f6929577e8cd\",\"/knowledge-medium/src/utils/toggleStore.js\":\"b66aff23a87de371\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"688a06cd906ded66\",\"/knowledge-medium/src/utils/userActivity.js\":\"134e4120f8994011\",\"/knowledge-medium/src/utils/viewTransition.js\":\"082dff9ae3219793\",\"/knowledge-medium/src/utils/viewport.js\":\"144ec04b8d78447b\",\"/knowledge-medium/src/utils/webLock.js\":\"af73523dc0ff4754\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"84dc21c3714c2ce2\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"2407c27623055fca\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"89c4b0fd8e4fe67d\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"0cb95790dcb8e560\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"bf92596f9b295416\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"a37bf0dd6a92cc9c\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"205a621f0ada321f\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"a8765672db286b30\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"af624fbd9260ef2e\",\"/knowledge-medium/src/vendor/react-dom.js\":\"fcc8d39e5ef79b3e\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"ff19fab4d9422cda\",\"/knowledge-medium/src/vendor/react.js\":\"e09851b9ab5e15a0\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
