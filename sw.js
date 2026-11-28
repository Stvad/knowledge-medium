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
		buildId: "4c9d06d676f1-5c5e30b5",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"d4433c0da424876c\",\"/knowledge-medium/index.html\":\"d4433c0da424876c\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-xi0lFqes.js\":\"12e0fa82b285a137\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"44607da72bc2698c\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-lFgSNqvb.js\":\"3a4e444f63c946ae\",\"/knowledge-medium/chunks/FacadeVFS-C2WcLJRx.js\":\"81209d38c7d9c7d4\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-7Khr8R5W.js\":\"665044a4feadbb52\",\"/knowledge-medium/chunks/MemoryVFS-DZE7gFSG.js\":\"b6588145ad0fe500\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-UHPQ-JpD.js\":\"1d8dfc485c71bb32\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-CQ7oXsLv.js\":\"36bb2df3a33d1713\",\"/knowledge-medium/chunks/Preview-BYSVDi2l.js\":\"0812c845cdd8951a\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-B4ZcOYv-.js\":\"b59d851a67e1b2f4\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-DO51TY-_.js\":\"076401f22869864b\",\"/knowledge-medium/chunks/freezeExtensionImports-BOa3b4_t.js\":\"fc3932b49ddaba91\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/lib-sLsWaEIT.js\":\"54ea87940a765649\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-8A8ycgYH.js\":\"2cba7a1b8ac13edb\",\"/knowledge-medium/chunks/react-BXPKhg4C.js\":\"bef80186122222c7\",\"/knowledge-medium/chunks/react-BkNKjs0p.js\":\"b7871e4fe3dc827c\",\"/knowledge-medium/chunks/react-Bm2ZgvrK.js\":\"eb0c544f80856f35\",\"/knowledge-medium/chunks/react-CNyQcVYn.js\":\"a351010fb352909f\",\"/knowledge-medium/chunks/react-DBhRFIM6.js\":\"cbf18981296a1040\",\"/knowledge-medium/chunks/react-DLCYxJq2.js\":\"f5136cde83f10336\",\"/knowledge-medium/chunks/react-UBK0t3mt.js\":\"63556a3bd377a85e\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-BJ9cJNW7.js\":\"2990b6a84e9d0c07\",\"/knowledge-medium/chunks/react-dom-server.browser.production-WCYWLaGU.js\":\"1ddcbf3ef913f775\",\"/knowledge-medium/chunks/react-dom-server.edge.production-DCrSYUnC.js\":\"dd70fb07e1589cb6\",\"/knowledge-medium/chunks/server.browser-COZbElfQ.js\":\"676f6839090ec4c1\",\"/knowledge-medium/chunks/textarea-BDy7JlzI.js\":\"bd2b509c1ab9d8dc\",\"/knowledge-medium/chunks/ui-CzLm23SK.js\":\"1fe9c82a62dbe991\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"509c89d88d600bed\",\"/knowledge-medium/src/appUpdate.js\":\"33626b17fc1ebf2c\",\"/knowledge-medium/src/appVersion.js\":\"d89518ad8df8d1e0\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"46c24f61767c7dc7\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"17c33813ba4b1318\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"7c184da11ba5a3eb\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"f30d124f7bcbda04\",\"/knowledge-medium/src/components/BlockComponent.js\":\"c2d1dc47aee31cab\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"faa1adc0fa173531\",\"/knowledge-medium/src/components/BlockEditor.js\":\"1b534d082515e76c\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"cc4d3c9d6c02a6fb\",\"/knowledge-medium/src/components/BlockProperties.js\":\"5c6554b06c79510e\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"2933120eed2af328\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"95e528ca5b3c8831\",\"/knowledge-medium/src/components/DividerHandle.js\":\"ffaaf186d1a32833\",\"/knowledge-medium/src/components/DraftEditor.js\":\"90da4a6390379df9\",\"/knowledge-medium/src/components/GutterPill.js\":\"a61cd2345f234365\",\"/knowledge-medium/src/components/Header.js\":\"c39c68a2b32b8e60\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"b6a4114bb2584683\",\"/knowledge-medium/src/components/Login.js\":\"44c33e1d4bed566c\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"8785a9db7f3277f2\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"f15bc174cf130e62\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"54701757a23b40c4\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"84baf12a68036c2b\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"b7ff2e35c62ea8fe\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"bdb6b7c73600fdc0\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"706d1b13edc06765\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"e635d5cb17c1c6ab\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"a783499beeef7b6a\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"503fbdcfc40cb82f\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"0c564915654355b9\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"aaac30d9ea24a888\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"9b00ac43d0ef2739\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"1a88320bee0db573\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"8b71121b7847a9dc\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"c496aef8e5d56f6d\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"16aca44cc75d5c4c\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"90a8e8f316b41913\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"42bd0b3062c57a1b\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"2fa9f379cad46b4c\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"e9f80a98f328a875\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"47d2c1706a9c8430\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"0fa5cd3f2d84e74a\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"277b381a4a961e68\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"a1302fda7c6e94d2\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"9604f9087cfd741e\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"4c188f50f948dbb9\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"81ca2c9ead034240\",\"/knowledge-medium/src/components/references/CompactReferenceLink.js\":\"089262267bd72436\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"7f067022e14d55fd\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"fafb0895119ea923\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"c6234e0f6a7f643d\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"be6c5a6d7b86289c\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"184f6124a7ce4b1a\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"655793c6971f5c3f\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"941279c6f99ce1a4\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"44c2edd662fd7312\",\"/knowledge-medium/src/components/renderer/BlockReadText.js\":\"76872e5caa7a9957\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"9aae4568929984e2\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"6bc3665d3a3788f7\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"727f19cc4d9822ac\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"3d587f5b67645356\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"87b61a855717e359\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"cf2e5d10e179f068\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"cff459b76576f699\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"648a9939e4b6166e\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"003a9834c8f2ab73\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"31b6e787627a586e\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"1bd6b8dd0282fd04\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"133980702907a00d\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"eefdd8092ea5a375\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"7acd90943d0f7a49\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"9167b178bf0ac7f1\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"8bb352c1a9e208b5\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"4bdcf762ba046e68\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"c87fcbc60abccb52\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"72cea19e500731d5\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"d702f27649396e87\",\"/knowledge-medium/src/components/ui/button.js\":\"11523b9e8366dc95\",\"/knowledge-medium/src/components/ui/card.js\":\"f2693efcdbb7c56d\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"c619a269e3de4d6f\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"056cb05f357cb7cc\",\"/knowledge-medium/src/components/ui/command.js\":\"59513b9908608404\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"b760b148137c2afc\",\"/knowledge-medium/src/components/ui/dialog.js\":\"cca546211880c306\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"7780b16635816ebe\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"3883b36e56682744\",\"/knowledge-medium/src/components/ui/index.js\":\"72e247a1d50e3f6b\",\"/knowledge-medium/src/components/ui/input.js\":\"fa271bfde05e97e1\",\"/knowledge-medium/src/components/ui/kbd.js\":\"9e65179764725ed5\",\"/knowledge-medium/src/components/ui/label.js\":\"5d8e47a7b6f356e3\",\"/knowledge-medium/src/components/ui/textarea.js\":\"786425d51f093c51\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"6b7cd44a4b139477\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"8293875d4cfb6e73\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"ca23998cf1ae352a\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"4113349db0425448\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"794352be5aad4383\",\"/knowledge-medium/src/components/util/error.js\":\"98c5b879e6f4b633\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"5f3cfd47f94c3e29\",\"/knowledge-medium/src/components/util/suspense.js\":\"8b7e1dd9d79f5468\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"00db3231cd9e040a\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"fb28c90121dc4c3c\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"47b93136c09a5271\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"8b00c0b19848aeb1\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"16271709c90c2f33\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"9ae20425a283062a\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"e94f1ecbcbf1e859\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"c1aef87e3e853a78\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"97da43c557545ba6\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"c17d76034dfca55f\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"046b6e413b06960d\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"7dda6cddde51292e\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"28870e3c52f72a09\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"4b4d5d8a2caf1147\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"17cc9be5e4fe0559\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"094837741a986e13\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"e2bac2086fbe54b2\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"4ba9c489cebe0e58\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"61feb30c464c8e9d\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"1eba6f8a90cf3fff\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"1f4ac4208fa62ba6\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"6b6a6795aeb79a85\",\"/knowledge-medium/src/context/block.js\":\"7701ff1a0059d2fb\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"227247948c646c49\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"619ef3e80ba97256\",\"/knowledge-medium/src/context/repo.js\":\"8b95da8eaed007aa\",\"/knowledge-medium/src/data/aliasClaim.js\":\"36a49ffff5b30c6c\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"c24fdd615f6ee495\",\"/knowledge-medium/src/data/api/blockData.js\":\"6ef0295dec9d05e6\",\"/knowledge-medium/src/data/api/blockType.js\":\"9fa2996e78813400\",\"/knowledge-medium/src/data/api/changeScope.js\":\"dda06222190d6969\",\"/knowledge-medium/src/data/api/codecs.js\":\"8b7e8af0a9cdc6e6\",\"/knowledge-medium/src/data/api/derivedData.js\":\"b83689f8d71cf7ee\",\"/knowledge-medium/src/data/api/errors.js\":\"6d73f016dd0cd7dd\",\"/knowledge-medium/src/data/api/events.js\":\"3872459e461b8f09\",\"/knowledge-medium/src/data/api/handle.js\":\"44eb3d335b1a10b0\",\"/knowledge-medium/src/data/api/index.js\":\"4036dbdcb5ab8023\",\"/knowledge-medium/src/data/api/mutator.js\":\"4af6cdae7bacf368\",\"/knowledge-medium/src/data/api/processor.js\":\"4b92dfcd21919658\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"ce6786205222118e\",\"/knowledge-medium/src/data/api/query.js\":\"6e6c7e65492b627e\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"aa45406ef999ba42\",\"/knowledge-medium/src/data/api/schema.js\":\"44eb3d335b1a10b0\",\"/knowledge-medium/src/data/api/tx.js\":\"44eb3d335b1a10b0\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"1b9bfebc490994d8\",\"/knowledge-medium/src/data/api/user.js\":\"a49f08657b1f6932\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"9a6f10fa3a8c7038\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"bab4c80d1d7071cd\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"feba2613ad8946f4\",\"/knowledge-medium/src/data/block.js\":\"5e812a7f1fda50ca\",\"/knowledge-medium/src/data/blockCache.js\":\"128b46f98fcd2b18\",\"/knowledge-medium/src/data/blockId.js\":\"03fe6d22789a1489\",\"/knowledge-medium/src/data/blockLiveness.js\":\"0fadd3908a4832d5\",\"/knowledge-medium/src/data/blockMerge.js\":\"aee6db7cffc7ade8\",\"/knowledge-medium/src/data/blockSchema.js\":\"4ced7353b1987080\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"1e51e6070c58b6d7\",\"/knowledge-medium/src/data/blockTypes.js\":\"ed723e26a1211b6b\",\"/knowledge-medium/src/data/childrenView.js\":\"6d27de6f5ce0c585\",\"/knowledge-medium/src/data/clientContext.js\":\"d918e252c7374e38\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"b9889b2c453a1990\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"42c238c5bfba1a63\",\"/knowledge-medium/src/data/derivedIds.js\":\"c4875042dc1efa0d\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"d43b159bced6469e\",\"/knowledge-medium/src/data/facetBridge.js\":\"7273dcb6c5503ff5\",\"/knowledge-medium/src/data/facets.js\":\"c6bf2975500e995a\",\"/knowledge-medium/src/data/globalState.js\":\"26290fdd495c8b1b\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"14509572dae6576c\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"7c3f4e5defcb22b4\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"263a0f28a2b0afc5\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"6231d83512465b66\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"8c1f1266e6dfcfb1\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"a0e3b4feb30f8f4c\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"b1a918175ba4d227\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"2d6bababbaf59d58\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"5cd10d7d7ac24741\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"8be797262194c03a\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"484394f8ee6c4c0b\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"f557e63466937b0a\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"071db088ecb5f987\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"27c40d8269802662\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"57bd28e9c2667f36\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"80b677b0734e06b9\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"ee6fec5c1b51ac37\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"f75c6647a057c613\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"a4fcdefb60cfa8b7\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"d9a52d3f9aaabccc\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"9092d7ef0b68d81e\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"a0cbcf5c59be5393\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"df35ea3daf95d090\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"b4fe93b59b1dd533\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"06fcc67883693dec\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"852ee8ae0461ea91\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"15da6e29c9b08a7a\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"d481a3f058a1022c\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"8709b7df34940bf7\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"7ce316682c92bbfc\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"433e6b4085c6204a\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"d05afc2f421f4687\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"33d5ce4ee2d807de\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"0f25b857418b9c26\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"465da7feafa53bee\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"bc1a489236785954\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"943690561bf8db35\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"99aeb4008c3b8aee\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"e87c4004eaad7d5e\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"6b3eaa43a61aceae\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"af665befc48d9818\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"53289ab0aa3de32b\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"cc709089fe3fde97\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"4c93152aa443d464\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"589619acbc4a5d33\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"72cad8ad34358a43\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"de388ab59537865f\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"99716398aebae32a\",\"/knowledge-medium/src/data/invalidation.js\":\"574be7885eb1db9b\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"e92e55f53382c96a\",\"/knowledge-medium/src/data/kernelPage.js\":\"f647e8bcf02798f0\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"11d1440e7116565f\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"960cecca96301754\",\"/knowledge-medium/src/data/localDbStorage.js\":\"48c941273a6ac345\",\"/knowledge-medium/src/data/localDbVfs.js\":\"834e9c5c041d3f1c\",\"/knowledge-medium/src/data/localSchema.js\":\"41179fd37117bd89\",\"/knowledge-medium/src/data/maintenance.js\":\"42c80c96316491f4\",\"/knowledge-medium/src/data/mergeProperties.js\":\"da911026ed6d2fa4\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"ab930e9db271c078\",\"/knowledge-medium/src/data/migrationsPage.js\":\"38ad0cdbb0e5c6f4\",\"/knowledge-medium/src/data/mutators.js\":\"ec9200df035fa3fa\",\"/knowledge-medium/src/data/orderKey.js\":\"713a4992c6bac1d3\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"a1b88ca1efce925f\",\"/knowledge-medium/src/data/outlineSurface.js\":\"786cd686ae74f522\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"dafdcd36fb71e175\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"417b4aa19f15d045\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"feeaaa2cdd76b1ce\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"adcad8077ccd513f\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"51275864a07bd2ef\",\"/knowledge-medium/src/data/properties.js\":\"177a26db380a70bf\",\"/knowledge-medium/src/data/propertiesPage.js\":\"0ed83d616d3e9b4a\",\"/knowledge-medium/src/data/propertyChildren.js\":\"89cf42a5de114013\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"0a63ddb727c7e82a\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"0044c708c412b3d1\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"24790590ffeb8a74\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"0bcfcaf18bf282f5\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"956725ce8e9d1c71\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"aa513d72e195facd\",\"/knowledge-medium/src/data/propertySeeds.js\":\"83f31e315996fb31\",\"/knowledge-medium/src/data/recentsPage.js\":\"bafd4ad71bf7384a\",\"/knowledge-medium/src/data/refTargetComparableProperty.js\":\"97edf29701689d41\",\"/knowledge-medium/src/data/referenceBlock.js\":\"fee3da9b2f8bc63d\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"49a028f83181bd6d\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"9a40ec40c5fde5be\",\"/knowledge-medium/src/data/repo.js\":\"feb291fa672ad859\",\"/knowledge-medium/src/data/repoProvider.js\":\"da7efe16e3a00325\",\"/knowledge-medium/src/data/rowProperty.js\":\"3ae5439b7c979297\",\"/knowledge-medium/src/data/searchFilter.js\":\"eb10fed07d2dccea\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"90d874d285baf71d\",\"/knowledge-medium/src/data/stateBlocks.js\":\"fda9e24190045038\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"9dc002b21d06b613\",\"/knowledge-medium/src/data/structuralInsert.js\":\"03d9d5f121b4da4e\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"4e158ad11468f622\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"16533d02791e5f3b\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"b59920c065bc1beb\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"0212452ff234a073\",\"/knowledge-medium/src/data/targets.js\":\"28489a215985e162\",\"/knowledge-medium/src/data/typeColors.js\":\"3ed7fa9afb3fd60e\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"163c5ab625e08642\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"a184b08b098aa694\",\"/knowledge-medium/src/data/typeExtraction.js\":\"6e6c734e3479ce0d\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"51887f0648bf3c80\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"f4f2fa7ad81ff27d\",\"/knowledge-medium/src/data/typeSeeds.js\":\"b838146dee301799\",\"/knowledge-medium/src/data/typeTagger.js\":\"601fb843eaba357e\",\"/knowledge-medium/src/data/typedRecords.js\":\"84b6ecb5de8aba69\",\"/knowledge-medium/src/data/typesPage.js\":\"4b8ca59c6b9206ee\",\"/knowledge-medium/src/data/userPrefs.js\":\"98708a44cef56e12\",\"/knowledge-medium/src/data/userSchemasService.js\":\"3534f8cdf7affa36\",\"/knowledge-medium/src/data/userTypesService.js\":\"80c2cff2dc077fc0\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"234dbcc165ee4ba0\",\"/knowledge-medium/src/data/visibleChildren.js\":\"2c078999dbb666cf\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"2845db4046b2747f\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"87dc8aceeb9570c8\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"fc901dab88b91f2e\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"9a5d410567fa70ad\",\"/knowledge-medium/src/data/workspaces.js\":\"60fab68ea571dfb2\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"b86fba2bd8ce46f4\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"e971adeda901aa2f\",\"/knowledge-medium/src/editor/atTrigger.js\":\"c9688896e6a2e7f4\",\"/knowledge-medium/src/editor/autocomplete.js\":\"1b4f80c5615d5e42\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"afab81ff4eac1afa\",\"/knowledge-medium/src/editor/contentFlush.js\":\"e850243fb8347151\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"1d59c2783297100f\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"4cf95a0b5f6bb515\",\"/knowledge-medium/src/editor/insertImage.js\":\"b50e65f4bab69c71\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"a44742859ea0a969\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"47b84fca53591499\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"e0ad2557c60e521b\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"d23d11b39986ac76\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"40514236f44bc9ef\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"6263e27a833690a2\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"fabe5cd482b73e2d\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"595aae1fc157bb3f\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"1fe8dc0c451ef616\",\"/knowledge-medium/src/extensions/appRuntimeController.js\":\"70e587007d6f7c6c\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"e0d70789d113d6f3\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"2d2701c645095a11\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"998925bdf8e71bd6\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"96ebd12fec1abaa2\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"e9a4e9b17b2f64fa\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"c924a1a429612b10\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"6703660c5edf788c\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"a9d4f1aee1aeca25\",\"/knowledge-medium/src/extensions/core.js\":\"8c0e142bf06f53ae\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"b611ac2839330f6e\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"dd314b77eb10309d\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"2187c4d47fe97f87\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"8cbc2bb5d722199b\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"b2bf90360ee2c187\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"3c51ebc9c3561e09\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"e7cdd801810e0a56\",\"/knowledge-medium/src/extensions/extensionImportPolicy.js\":\"a6489db049692945\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"de536b6e94437f31\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"ba22d0813a111a0f\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"6f75a230449a506f\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"0e5fcc3be98dea0a\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"8e2359d68aa27e05\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"9c792c2c302bc3e3\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"0968e95ca56ec1a8\",\"/knowledge-medium/src/extensions/normalizeExtensionSource.js\":\"f45afaa47db8221f\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"c33b6cb394f8fa43\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"ce0b0caed14ac3b1\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"135f5f76ea2bb581\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"10060a3348fbf150\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"92011b6e8df640eb\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"ba4551eb4338aabb\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"3f9ea4370348b085\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"b39d4d6eda65fb92\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"3544dff2f002a0de\",\"/knowledge-medium/src/extensions/transpileExtension.js\":\"bf30fc6a6e0478b6\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"12f62448cf8d6c57\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"1a901d9cceb5a130\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"5feebacf6db8ede9\",\"/knowledge-medium/src/facets/facet.js\":\"9b4dfe484f1f7a11\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"1faf5f03c68d6040\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"71da41baf0e11af0\",\"/knowledge-medium/src/facets/togglable.js\":\"088486e84dd894f3\",\"/knowledge-medium/src/facets/variantFacet.js\":\"162fd3c1e4681250\",\"/knowledge-medium/src/facets/verbFacet.js\":\"30e74dd43934ccf3\",\"/knowledge-medium/src/hooks/block.js\":\"1fd432b1ee609203\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"6ca1efc1f923ec81\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"a317b6c5a2762a21\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"1feee1e315682adf\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"0a145054222c9d54\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"8fe6e8073a479aea\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"01caa2cd24331861\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"f3ca2b77e7643d0e\",\"/knowledge-medium/src/hooks/useFacetValue.js\":\"2dc3c532065759a7\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"06da3adb7bf4cb16\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"ed977569e307737c\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"29183e70a0cf3e09\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"3c3b0511027a8292\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"a71676333ed5b6a9\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"4e779db506e1c70e\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"b9d6457e06846f88\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"72db678e88c7dfc0\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"a6b7a8aee116812a\",\"/knowledge-medium/src/lib/utils.js\":\"44b27767089c4b93\",\"/knowledge-medium/src/main.js\":\"bdc3d6b3e9912978\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"449f94ca437333cd\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"4614e507aeabbc25\",\"/knowledge-medium/src/markdown/context.js\":\"6dc9eaf96afee4b5\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"e7038f1b883d64ea\",\"/knowledge-medium/src/markdown/extensions.js\":\"a59e5ea49667661e\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"d520ee85a77888ab\",\"/knowledge-medium/src/minimal-editor.js\":\"3fd69b79c9cc248c\",\"/knowledge-medium/src/paste/armedCut.js\":\"46c0e919a225e584\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"8ab8f15bb21c9fb6\",\"/knowledge-medium/src/paste/clipboard.js\":\"983ea5366ecb7bfb\",\"/knowledge-medium/src/paste/decision.js\":\"6257165cbdf568d2\",\"/knowledge-medium/src/paste/operations.js\":\"5b8bcb4b7f9429ac\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"bc164c9d0bf3dcc6\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"cde8e28f625a62d7\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"bbe470244d1bfc47\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"a74127d6657050bc\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"a512b0b13a8dc5fb\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"0b53094e3bcee6b7\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"3f8d113a5006e347\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"b239722bbaef4ca7\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"8bc0115a18e21c7e\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"30ac5bbbb9616a0f\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"d23d6d2a9770c3ac\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"ce2293c9a6a60375\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"dfb68ffc01c5df02\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"964b2330b129905e\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"35ab262de420934b\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"0699fc07b9dc98ec\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"a1b87351eaf72f02\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"9add01bbfdc3eb4f\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"9b6e1b20c0cf3d36\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"92e95dc6a655fd32\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"0095bf3ccd5e145a\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"c4f185d992a97bc5\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"148c459993d72ba8\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"595e896634e69ca1\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"afd409801b482b65\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"68dc546098ff961c\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"71edab5fd9524627\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"e3d07a33d2953f7e\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"013ff28fe6719628\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"9f6600bc28bbf09c\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"f14d9633f48d3f98\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"2317b73400d92a1d\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"742a1ca4b50d9a7d\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"ba221e96e4fb0eef\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"d0d971cf03ed6381\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"4158518910e09755\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"b925c929573d95a2\",\"/knowledge-medium/src/plugins/agent-runtime/dayPropertyInputs.js\":\"cc47eccb04b1fb39\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"ecf74268b249abcd\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"69eb49eee0198ccc\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"aeef4b08bb900708\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"f79ba429213f580e\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"5015ac0e30c8eec3\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"5c59095adc1337b9\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"4e98372b162dd51c\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"20735664ef2231e7\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"fba8263f33d1cb9e\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"a53e3c18791e7b69\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"f8564c556915fa92\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"ce6273ba5067ed9f\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"18cd5f7371d3c27a\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"9e2ee646cb8389c7\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"1d335a36e0121bec\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"6d2a5d054263c0db\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"5cddc9d2be89f0d6\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"aeda3095eb54e063\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"e70c375e0c743cf5\",\"/knowledge-medium/src/plugins/alias/index.js\":\"ee277fcb5664c8c1\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"317d20d72f1fb514\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"a7c4f3c41059e5c9\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"26f7af30d569be6a\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"cc9052ab22cfadd7\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"1dba500ce55a0dda\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"a19734068fa0a545\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"f7963fb4f19b7da8\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"450f40d45677014d\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"5045e74f13456f29\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"dd770fdab02b696b\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"b596557cf6086073\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"3222f2fa018f3de9\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"7d6fb2478e9c6430\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"6b509177090f93fc\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"2282b0777acbf07f\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"3f266782a30b15d5\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"76afbc1d4ec4fece\",\"/knowledge-medium/src/plugins/annotations/marginAnchorLinks.js\":\"fa862b6af4f825aa\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"304832c518d9cce8\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"f0a0263476592a7a\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"aacf1d6f9155d891\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"589e342bd7cc5aaa\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"4da7d2457c98f8c0\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"bf3846e70d752c38\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"9d344d4b8d2269d7\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"930690acb07f741b\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"8c245d4ece7de40c\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"47a699f938a3a9d6\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"60535daffa01d349\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"b7e0cbbeb44dd5ec\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"76bbd69cfb294752\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"f41e85fed3e4d3b4\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"34fb135fa27d4d3d\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"25c39a3f96f2fda3\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"e3bb9d2cb75e3498\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"80ef3f28c44e57ea\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"487ed4a10d9bcc75\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"8832c0bedc50570c\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"002b6fd1a2f64741\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"4429e07d1fc4604f\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"4164b0252df1683d\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"993591d42246518c\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"ccd48cefac2f6700\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"ad6a445b1c9a93e6\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"f013bdd70204e513\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"0a533b3686032f0e\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"73e9dddc87456fc3\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"0ceed68322b71950\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"0276118e6dffe7dc\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"50413de60fbd4f16\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"3bec75d1fea16750\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"cb548a314f7bb86e\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"7f450d040d3576cc\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"503a94603f4e3279\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"186cba6606506063\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"4b515048ee009168\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"0c59e068e91025ea\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"edb2c60d7f44fe8f\",\"/knowledge-medium/src/plugins/attachments/browserMedia.js\":\"2aeab17062932e8a\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"b8e1d09d3e301e85\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"7b7b7ebd76f0aab7\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"9e50fdead68c5c62\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"f65c6d202ce19dd7\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"545fdcbaf100f791\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"cd3fa750be7be987\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"5b14aa341877ed2a\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"e075337d7752cb8b\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"388c9a7e709e4b2c\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"96f530d8b6ffd044\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"3de6abaad65d0664\",\"/knowledge-medium/src/plugins/attachments/mediaLanes.js\":\"1fb4cb618f8ecc4c\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"96cda5a72f50de1f\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"9afa56bcf527187d\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"03ad244eff7c926c\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"57615f72ad5026ae\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"f08d2fa8f85f047e\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"f4aac31c75e2bbb3\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"b28a3b79f64eaab7\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"e8f2c656e0cacbb5\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"54e48fa8a7b9e4f7\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"b844ec173344d3b3\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"845447921f14b239\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"4ec8bc9dcc9d6ad9\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"f1c820be1f6be8ae\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"6bc47608a0392b92\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"8d11a74bace1bdf0\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"0be2e32faad4a9e2\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"ba24df770f949b63\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"622a9bfc930d405f\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"671b6c76e03bce4a\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"08364e2ef3f05651\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"7c7cad9a925251fc\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"2dce7140ce4ae8c8\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"74dd05c8b0b061e7\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"9b7d3f01b01f7e42\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"6701bd3bb29b8b0f\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"8a2ee778f88ac006\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"7de572e37164fe19\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"6d34d1e763decbcd\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"c181c9923e0ee002\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"5a84a8d7592aeaca\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"1b512bf54f7b2799\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"529931f8de8033df\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"428637de5dc60b4a\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"f25f2ebfce1d1089\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"37207fb9f4ec01e2\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"1e6399056439dafb\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"cff82b8d2749d0d6\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"f29398ad621c909c\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"45c9b92c910a7b63\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"b356517814e42fa0\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"c2d29d94d2617a51\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"f7bb20912752418f\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"fb8ba7a7eb27ca47\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"be1cef777c6b45e3\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"59d5231b422296f3\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"0ce47aadb7a6c082\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"0c64692006f2fcb6\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"516484fe8492bab5\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"9b25c0969deffb02\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"69f057cab598adc5\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"f6c4dea134b5cec9\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"bac021c7c26c8b4f\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"5b1a7765cdac55da\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"494d7a9c83090fc0\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"a17ecaa725abfa1a\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"032274d33646f174\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"464b9dcaec7b4446\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"0547d8f8031d9a41\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"c146bc554fd59080\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"3a8e94e1907ca25d\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"4fa19cbf7a21c17b\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"ff381b562e85a335\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"7c7b70d5afcbd5d4\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"227a1d5c1211d954\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"c343df819ab1110e\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"0802c75e1fa97328\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"cd088a9fabeb7673\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"15d3563c5e8d5dc1\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"8ad8db42672f3d58\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"8fc15740630e57e3\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"7f513bb5370a2268\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"d7567c170b8227ef\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"ca22491714b15c65\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"bfb02942e8498368\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"52f6528ef1fc0da8\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"db8b9986cf4df5c6\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"4b11f0c16c74992e\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"8dac20d126978dfa\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"5f1233729324c49c\",\"/knowledge-medium/src/plugins/character-counter/subtree.js\":\"b90ac43a3ae214d1\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"01f1e4c6eafeb15d\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"337a906c7749656f\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"0fbac14bfb8de77d\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"b3ecfe979d581cea\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"ff46589605340e48\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"a46e3751cc7b860e\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"a5aabd9b357804bf\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"ef728b64c980f385\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"a46ddfd20aa7908a\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"f4fb129bb0dbd5e0\",\"/knowledge-medium/src/plugins/contributors/ProfilePicture.js\":\"b3a172fbd3f19931\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"f2754ded0cdda956\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"f83f56ed48b6784a\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"19533d5d9fa5870d\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"c94d4c4de50e4f6c\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"3c4d66df3e2c5268\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"01fa6d5208a025a7\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"0fac181350c095a3\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"595105cbed25bddd\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"6c0b79f36d315b03\",\"/knowledge-medium/src/plugins/contributors/useCommentAuthor.js\":\"0e5feb3f390c7883\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"141d26821cf961dc\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"87a45b214463f4c8\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"c49815a36ad5a427\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"331b81510622e83f\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"54c953ba6af157fd\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"beeac23cbac08cf1\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"d71f755aa2e3de94\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"b77f1a5294f5f7ec\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"3828d424e9c87c52\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"c0daf8dc535dc562\",\"/knowledge-medium/src/plugins/daily-notes/DayPropertyControl.js\":\"6605b8073d5b59fe\",\"/knowledge-medium/src/plugins/daily-notes/DayValueReferenceControl.js\":\"fffbed7c65561956\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"11a73e30b30547dd\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"cfc63f6883e9db5e\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"c99354556844a9dd\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"8aa0bdf7a3269d00\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"a480152f95e92b1a\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"e0f177b456854f44\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"442e564a5522f44c\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"0442d70c9ee0b023\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"300b8d8adbd15c05\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"62d7b4e9f9d7f73e\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"f2051acb68839d2b\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"a328a84d84a67442\",\"/knowledge-medium/src/plugins/daily-notes/dayProperty.js\":\"9343852a35e7f878\",\"/knowledge-medium/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"1e0b741b1bb4a77f\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"3413caefee6b30a1\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"834289263242ec5e\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"cefa57f39c40c5f8\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"5c06c995a63e55c4\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"0b724100e61cc3bc\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"32916e770572b63f\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"2b2cfb2086ef5e9f\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"2bf9b25d785b99ec\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"f1507c6b7d8dbce0\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"f4b91e655cc1bcfb\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"24a8a9fcfa8ed47c\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"147cbdf540620c40\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"bb8fe985a4701980\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"bf1f537bb3eadfa7\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"7213eb61a3a61c10\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"15254e7cc9e41864\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"a8260d3bc12d6b20\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"7fff1627d4efde58\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"7cb323de93d9767c\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"82c2c1e139135fc8\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"bc5ee1dda7d4a48d\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"1b472e26d07bc421\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"04acfc1ae99ec2bb\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"3b54f6eb310e4584\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"732b05528f7c9b71\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"c0af83a5d31d4c1a\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"c117b7cb844d6f5c\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"b2fbd6fba5fc4eb7\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"753b333e217735de\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"69e87d59353019dd\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"356f2d095ed75706\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"b1aa0a152a390262\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"c8b539c61af1a970\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"c03e510698a96e4d\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"2807b910ddce3d88\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"1447d4817fe6279b\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"9b5005f946312983\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"a325f6bd2302fb36\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"e24563f270d3460d\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"dfba6dcc0db70dff\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"51d081c9f2e4d2ba\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"98abb83f81cba81c\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"095a07ec1adff088\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"3c6e05c63c9709f6\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"552074df40a8becd\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"0364069e16f41a8c\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"04702cdf07ad1c8d\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"342662dc9bc71328\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"0c5850216c93648b\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"646458ecff08cf9d\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"fab635e03bd26c76\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"a300e49c2339eec4\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"edf6a04f9f07a178\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"9426b1f5c58d5d42\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"35c4a4e03a225916\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"d9f2c49c50f5d9ca\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"a9fda0de65238566\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"629d6c08d4cd5199\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"56d307480e912ff9\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"dc4ae3032f8c0997\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"911edcea9f1889d8\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"c1f1eba712cf176e\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"4f160d75d95199dd\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"3ef1d3440d58ff97\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"3295f5c4fec799d9\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"42c5b24aecf1ea48\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"244d4ae835841bfe\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"42eabb1f1c33358a\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"0a634b5fcb742bd5\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"ca173427d5580ccb\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"328ed408b3a7f8e0\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"95586729d2eb884a\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"cac13222d4bbd4f8\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"9cad2247a7a2c910\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"b15e451a3d394a5a\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"8f053bb5d237746f\",\"/knowledge-medium/src/plugins/geo/index.js\":\"3e7e2e4794772edd\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"6713c26b2261342d\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"aeb101445c91c5ad\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"687e8232787a2b89\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"59cd1482b8a2eb34\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"9fcc970b5b77a9b5\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"7483d9fa7d7e3a23\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"6a83707a6c7c8511\",\"/knowledge-medium/src/plugins/geo/query.js\":\"4894f4c8c9203ce9\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"013c700d686cd2ba\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"1c693f24671d8b6a\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"061224dfcaca8f23\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"41fa0b6de8a7b000\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"becc1f6ba5ea9e91\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"f6108f1dfc505a93\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"5b993a604366b849\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"7ed68c20631bcc15\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"828d35b434d17da0\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"70ab4efee94b133d\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"88f6d3a98c4a1a21\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"da78b2370433e282\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"29e0d6ce07c3770b\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"46f58bf6b2c19d92\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"50d51106aa773034\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"e19a6f836d59c3db\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"d0c778b441a0246e\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"03a43fba709d01b8\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"c31d287de33fcbcb\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"80f6715c058d8613\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"df3d3706a53ddcc9\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"1c981936b27c419b\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"4b405d36396afd59\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"dd49c9206638745e\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"7221d521336d2b2e\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"4b0cfab90832b238\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"3f8f34595de850a6\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"ee24f46ecdf41b45\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"98a0ce34291c8133\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"ee3abb580884741d\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"63845dfc710e4b2f\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"816cb5904b53facc\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"06e250f8f9d4275b\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"98cbd5f063a7b58d\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"32a36b981fb1cf60\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"aa26fa3a1be57de9\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"2c551bf9cb817ad2\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"5516053ccf8fa0d2\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"a3260110719650c6\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"c751547354ddf0e8\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"213f0ed633b39923\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"a20046f647b23398\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"15cb923ca078360a\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"56de18783da06e56\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"9c608ed2028755e4\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"77fcb71a7ae01185\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"fa8e8dca1b3cdd03\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"38002827418e476e\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"050d3cb39b09e674\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"8d1080757ccee2d2\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"71e4b66332983cc7\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"cc9fddad99f2a1a2\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"a2c39c3de6e129b4\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"1de602adeabc4086\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"cb54825f137b5958\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"a1f9cf2f28d968ff\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"7e4f04a6460616c2\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"3a8e847c8a593bbc\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"816a4d90fc4386da\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"09f89b06ddf0b8dd\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"6008743fb89b19c0\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"73086d3fb74ac21e\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"58b33a9afb1ae449\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"39ad1785e5fe876c\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"c419e825d699a8c0\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"062d92a417e60081\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"3e3c8c37e35659cf\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"b3fbe319bf948f73\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"5ae0700ce92d9b89\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"ab3e0d644a9aa180\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"ed1be72c81bc695d\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"44bb80f85895551a\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"ee3630261df2eaa3\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"4cdc659a75fba105\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"49b3e992b094ba60\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"5b693d5838668225\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"eb84ca024f237cd7\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"82479fd2236fa811\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"67102d112e5296f5\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"746ce611524781f6\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"3a9137ca9defd965\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"d6d5bb6c64d6dd5d\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"20ac0bb2bdb7a361\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"f0a6dbc2a71923e6\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"b6aee930bf9c6533\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"c1c76e6ea01598f5\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"27068e9296a09646\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"9a5301866f27f203\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"93510c73c33e60d1\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"d0020e1be9927500\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"d029f0f6fecebdca\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"11deac0c3715cfdc\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"e3354b4a71b3581e\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"1924f366d4ac5d08\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"02fbee549163966d\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"1a8953cabe9f290f\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"b17bb4fe1aad8890\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"e1ae3d44ef2bfb78\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"03b319bd001e9acf\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"6a09843df6b41e40\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"5514d424a51b483d\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"43a6c58be89c1de2\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"994a280ccbd5e62c\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"1d40908c200d9019\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"43f2f88ce85b6ac8\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"d9e24645297df205\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"6148fee3a3a50b68\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"fe1a8ff245b77d88\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"a3e2af3b1340c864\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"d2e433aaa1b8ab2e\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"4fc6b69668696362\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"fbc16fad3f6969af\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"06d2712e2f96b8a2\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"5eee5e6538c6adb6\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"b160747da9e43058\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"8233f37e0c715f5d\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"f61f16d4576e7506\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"dab1306fefe4576a\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"4da2fcb2783baf29\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"ffab9f6f3d88112c\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"356aa93fb9f67ced\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"6d249d70bf65a864\",\"/knowledge-medium/src/plugins/recents/index.js\":\"93235ffbfa461ae9\",\"/knowledge-medium/src/plugins/recents/target.js\":\"e46fad9712114af8\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"412c7de1ba08e52b\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"6167ad997d6e9698\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"8b257ed8075227e5\",\"/knowledge-medium/src/plugins/references/index.js\":\"fac5cd4dc66475d0\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"b1798f55013ccb72\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"8d8a0700148cbcd6\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"1135a9fd69dc5945\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"cc7fb8b126b3f170\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"7fded070fc384251\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"055d0e6c30decc6a\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"d28016882a90d5e1\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"8a1c034a5f452da4\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"1fb938429679b76c\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"a3c14a5acb70e2ef\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"ffd2b1a4ca2134a5\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"899410d5ea5a5b34\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"e3ce871c919213d6\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"afd65f0d5e9a1335\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"6451f4e9bbe66e27\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"3e2791614eef5391\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"69f86df9ef48af76\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"dd20896b74017533\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"19671a10076b5074\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"d15b4f9abdf63cb6\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"57ec4cb87f057733\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"4b117beac8521860\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"55712aae3045f137\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"f8abb5606cdc1f60\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"a374db90f8de0b26\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"040f0b69b11ef1de\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"30b58cf83c4c23f0\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"72604804f0a07fec\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"ede1e7badb3531df\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"b1a91fed7843583f\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"0d79c586d803d11c\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"4216a542e3ba498b\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"40f8b9d1bd14ef76\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"cbc1de1472980309\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"1de5c9368e0962b0\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"d90aaba81617cb17\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"6aec8ac829c9f2a2\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"16119ea20408a933\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"5a7db52f017fdb07\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"b1b8cc38c2e93445\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"037047e4bfac056a\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"f129c4f62f9a145e\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"9efa9f70a0141323\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"0985ac0956899478\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"61bdebee7154fe34\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"ef9dcf1940d9b15b\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"a7468296ca3ad4d0\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"2a582994e7d017d3\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"7a8f1d93efcc644d\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"9c60204ccf622aa0\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"a1305a3a85ca4af9\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"11f6a3f84447e4f9\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"5abc27170e99ce4f\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"91b77fa479cacd26\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"9d69cd6d7fe54051\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"caa3cd53999af913\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"3fe73d331932e8a3\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"6d519b6fadd3e65d\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"2664bbf7aed67b4b\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"d4afb05c860b1f7b\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"7017419dd7d2645d\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"112f531bf6a8f1c9\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"85bdac1273beb47e\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"b1065553788aec85\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"22021e049b01720b\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"0eed3040d6261ad3\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"4053a281d829cd74\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"f2aabea1bc0f85bd\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"428b7e3095759736\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"31f512d30abe0d63\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"f0f872d3edc2d706\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"80e77471a0c7e54c\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"25ed483fe50d0bd3\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"3f6461f57a349ea9\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"5d584e03fef95322\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"1cfc73a2c85c05ed\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"9b5237428b903664\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"388bdd9643e38348\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"62c4ff9b713de0a7\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"d97c672132f3d5ac\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"3dd3bf8a47e33a7f\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"535702af435bf200\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"0fa622aec3e3c52e\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"cf58385ad3a30c51\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"e4767d54dc5d0fab\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"8387f82138972318\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"701927cd99ec8360\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"aa5277b36501b294\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"918a390a093fcb50\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"901fbe7dfbf5793f\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"d2e66b0849bf2c13\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"6cc998f9f57b0c16\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"3ac77a32189cead7\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"a3303274f1a89f35\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"a6ae916c13d7e2ce\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"add70de59a694679\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"d267aa7afa8d4ffa\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"7801ba2501f95e9a\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"8525368502e773db\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"6dfc9264bedc7773\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"333e99e708205cdf\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"b76cb34bd37816f9\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"8b2098f9cea95c65\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"14469e2135cd9e60\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"f6130dad0e1608e7\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"be66d1660f1ef39e\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"e740e87d891eca06\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"9115bb068b656248\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"d535e6da14aa0c24\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"5bffb5909b792a68\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"f5add014a733d0cb\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"226bbe94e84bce4f\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"cb54e41a255c9670\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"7170737661f7ed77\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"6959001185a07346\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"e1bf9c32887eef3a\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"137851e18eabde76\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"8c68e96c95f6ba9f\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"a762c418113cba99\",\"/knowledge-medium/src/plugins/tables/childrenViews.js\":\"b0f226696d2d621a\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"3b3709ebdd80d665\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"f8e6288bc49bb2d4\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"44983619e907513a\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"52ce96b66845c25f\",\"/knowledge-medium/src/plugins/tables/index.js\":\"d748820db340e087\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"4e0c0f61e7e6a712\",\"/knowledge-medium/src/plugins/tables/model.js\":\"02c5584ec6690813\",\"/knowledge-medium/src/plugins/tables/query/QueryText.js\":\"1218397e5f78ac44\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"c794fa61815a6ea3\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"0ffbfda411a28255\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"2ce61046fc3c30a2\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"c04f871f82725e31\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"8c1ece3ae4dc37bf\",\"/knowledge-medium/src/plugins/tables/query/registrations.js\":\"4a30677c89e45c63\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"146e46d3187ac911\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"5470e720a5f89c8b\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"b76b14b87abc02ce\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"a3ab57710a754ef4\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"0c495c83c1adcbd6\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"61a1843b05dffbfb\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"b3af144b5aa0b6e8\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"9f4778dd91b56835\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"59d8a3a13873949a\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"67d6b27726fbdbe5\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"5a720fbe0c9bf554\",\"/knowledge-medium/src/plugins/todo/index.js\":\"d0e3660bcf59295a\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"72958b2480f18e96\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"9ff03d5029de8a86\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"55d72ff459f002c0\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"ec5f2ac400ce998a\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"25b3016a5f6fb792\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"210fef36cc0d4570\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"a579ca08dbcf9482\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"b13ee21e74e45a6b\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"a5d8e25d2a5e2241\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"8a7db25afcc1f3f1\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"48eec0404bcf3498\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"5f1f45256fe86d82\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"7e2a3baf17f10e75\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"6928b0722ba65c19\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"9030626b771c5fcc\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"b7b80e3d010186d0\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"4e5431034f0169bb\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"10ccb0d661db71e5\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"b5040aa1d64b48aa\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"a0698f33d76c583a\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"1df8bf461853ec18\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"bc66510b859718be\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"08d6c758e0d07155\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"d7e51ce96f3cdace\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"b1dd49ad0390185b\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"5fddd976dc553f02\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"e9768619e71e6435\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"eb07a7fd8b6a1fba\",\"/knowledge-medium/src/registerServiceWorker.js\":\"4105659a26706e31\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"ce2182927c449082\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"7ef478757ebc2d00\",\"/knowledge-medium/src/services/authStorage.js\":\"79f40a0b26f96d58\",\"/knowledge-medium/src/services/powersync.js\":\"4a3c6a7a91d7232b\",\"/knowledge-medium/src/services/supabase.js\":\"da5384d55f52bade\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"286a813435c46891\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"8eff8e6bab4b3bde\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"c9278fba14e1c65d\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"942cc1c105c1af2f\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"7970bd0abd29bd77\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"d33ea6e36a0370f6\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"c1252a43acdcf509\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"0a9c284691bc6526\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"ac401cff99a55a67\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"f7e450c53c17d90f\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"04601b438aba3278\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"2e874977711d6bb6\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"f011ed54ca6a5bf9\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"0ecaa92769a4d373\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"bacd378183619b7e\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"0f48ba12e0270c44\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"a739d31951d00d89\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"81bfac63716ea92b\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"6999b5d5f58b04af\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"1e88a15f94a53a3f\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"50fce10278e8dbd6\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"d898b80cc034f193\",\"/knowledge-medium/src/shortcuts/types.js\":\"1c61dd77ff27f8c6\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"22fc998b646f5d7f\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"8ceab8fc5e9a9267\",\"/knowledge-medium/src/shortcuts/utils.js\":\"14f6a73de765e51a\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"d24a34e49ee0d81c\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"da3c4a6a5c8240a3\",\"/knowledge-medium/src/sync/byteTransform.js\":\"e53d0f958473ef18\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"684050a2ecd7dcb8\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"c0895113ca4b79d5\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"dea9d53539c673ef\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"20c26338f90b55a5\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"8c5a1f5aaf40607a\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"8e532c71b4c95a62\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"69067d46855491ea\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"e3bf9e7bce5552d7\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"267f9e6be6383bdc\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"9cd85dec3fa319e3\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"86ef0cd081ffc66d\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"399fc2e485d62559\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"c680e9a73dcd66e9\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"f0abd278b44e4595\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"0a16a4ee4d9ae36c\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"6e9f3955bd98c67c\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"d11ef102940a98c5\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"ab56dfcc1e0fd762\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"e69b87ffc60f460c\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"5f23958e749e72de\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"ebfbd77cf5828ed2\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"841213ee5ccfa7a2\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"f1bcda8e70596a2b\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"93c4665e51506442\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"df1d1e38420bb50e\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"e2a48fef40f3f970\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"d9a56e574eea835a\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"e758c39d44fe46ae\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"38dc114ef3e20ae3\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"3cbbf62e9f229bb2\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"f578fb7d7bda465d\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"7d20e7770cf97ccb\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"fbd09bed4810b965\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"3cb0ef1cb81068b5\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"b76cbcd5754d3d49\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"f0aeeb4c4ff8d486\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"eb9ef36ebae343ed\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"e1a23c9c59119f23\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"6d089fc548390282\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"e3ce147093ee07c6\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"f205b3663dd14f68\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"da4c4bbc15b8ed0a\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"d6b60511a95d1d41\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"0557fa33b5e04194\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"c20d98e6792cd4c3\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"1e3fb98433f163c9\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"1805300c3ca40eec\",\"/knowledge-medium/src/sync/transform.js\":\"d94e9904fe527b99\",\"/knowledge-medium/src/themeBootDefaults.js\":\"8c2fd4954649f4b2\",\"/knowledge-medium/src/types.js\":\"a38a9d53b52ab03b\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"b6594084daf66b25\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"5d30d6fdbf1002c8\",\"/knowledge-medium/src/utils/array.js\":\"51a08740a1587d35\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"d56f043fcc5713e7\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"3f42b289171e4c1e\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"cc2b699c4b6247b7\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"d784bf5af5d934db\",\"/knowledge-medium/src/utils/callbackSet.js\":\"b79aa9d3b44cd14d\",\"/knowledge-medium/src/utils/clientId.js\":\"d14ab99a36287b5d\",\"/knowledge-medium/src/utils/codemirror.js\":\"7261e632f6901fbd\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"a9252e22354a9701\",\"/knowledge-medium/src/utils/copy.js\":\"b2b0a4f0072cd456\",\"/knowledge-medium/src/utils/dailyPage.js\":\"db2e8759a45b6a85\",\"/knowledge-medium/src/utils/dbForensics.js\":\"b9d8cdf804f1fdac\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"c3804043e1445f65\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"26a1486e097173d4\",\"/knowledge-medium/src/utils/dialogs.js\":\"65946f13acda1071\",\"/knowledge-medium/src/utils/dom.js\":\"1cb77448d5d882fe\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"0d262fd78d64377f\",\"/knowledge-medium/src/utils/drawnWalk.js\":\"07808ec05a55bcfd\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"62a84760d32a12a4\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"bb3b28041f61ba3d\",\"/knowledge-medium/src/utils/flipSlide.js\":\"fb66bb945896ab9c\",\"/knowledge-medium/src/utils/fnv1a.js\":\"ab1cb15ff6b0dd91\",\"/knowledge-medium/src/utils/formatBytes.js\":\"5b6cccc101ab6997\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"337b971796369097\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"b88f4b728274134e\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"3a9c1ee969bec13d\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"6283d42a89660586\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"f96456a9398231fe\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"365f5daea8cfae96\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"19354db1ba5d66db\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"6dc277680b4bcc0f\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"cd7ee0e913bfc0cc\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"09e36f6b2060bb51\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"b830d7d6aa3f05ca\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"f3d52ee88bbfdb91\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"f1e2c594fffdbd36\",\"/knowledge-medium/src/utils/markdownParser.js\":\"2c329a0c3f04466c\",\"/knowledge-medium/src/utils/memoize.js\":\"f3702c4d977ed7b4\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"396110588b295ba2\",\"/knowledge-medium/src/utils/nameList.js\":\"6e12d9a258a7d1e3\",\"/knowledge-medium/src/utils/navigation.js\":\"85ce46e4ddda11da\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"6a6f5701bdde5c0f\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"de77c0e07af3366b\",\"/knowledge-medium/src/utils/panelClearance.js\":\"3c3cf173020b161f\",\"/knowledge-medium/src/utils/panelHistory.js\":\"1dd7194b5e5307c1\",\"/knowledge-medium/src/utils/panelLanes.js\":\"2a50b807079f15dd\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"84d454c0fed32dc2\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"f2403d56a012f00f\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"f7d96166e68d8dc0\",\"/knowledge-medium/src/utils/platform.js\":\"11739bb45aff1fbe\",\"/knowledge-medium/src/utils/pluralize.js\":\"014313633911dae7\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"f4a15bef164cd993\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"07821ba3aa928f4e\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"54cb62dbaafa16af\",\"/knowledge-medium/src/utils/react.js\":\"5dd82cab288385f5\",\"/knowledge-medium/src/utils/relativeDate.js\":\"407e615bdf95156a\",\"/knowledge-medium/src/utils/relativeTime.js\":\"d7dbef3b5b9111d5\",\"/knowledge-medium/src/utils/renderScope.js\":\"c0e955a89148e9c1\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"fef4a8084e7d2429\",\"/knowledge-medium/src/utils/routing.js\":\"da45778a8e5af562\",\"/knowledge-medium/src/utils/safeMode.js\":\"b99f468f0577564a\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"ddcb2c6514d42d50\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"48848fac952527f6\",\"/knowledge-medium/src/utils/selection.js\":\"52214d6f8da06cfd\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"9c2530f23f4732aa\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"878f0e53a27938e9\",\"/knowledge-medium/src/utils/state.js\":\"d8957c56c8f91b5b\",\"/knowledge-medium/src/utils/string.js\":\"221bd8fd8d4087b5\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"5dfe4d7934ca7263\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"1ff03ffcf0b2a048\",\"/knowledge-medium/src/utils/toast.js\":\"21702c9bad47533b\",\"/knowledge-medium/src/utils/toggleStore.js\":\"39aa995b85dd1fb6\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"400db8a09c7d0dae\",\"/knowledge-medium/src/utils/userActivity.js\":\"316cb13454eefdf0\",\"/knowledge-medium/src/utils/viewTransition.js\":\"cdf0424329a3071f\",\"/knowledge-medium/src/utils/viewport.js\":\"6984782c6397a382\",\"/knowledge-medium/src/utils/webLock.js\":\"71c4afd540c0c9f0\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"bc56b1b6f049ec6a\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"34747ab7e35b2a2f\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"aa37d9a6cd2aeb78\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"36694095d5833a6f\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"6c58d5892cb63b42\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"f761e2f34de68b14\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"5e502696c932b82a\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"d82c86a001269718\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"3c289f28f7e26b54\",\"/knowledge-medium/src/vendor/react-dom.js\":\"2c043c9c5df1d15e\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"187058ee8eab01fe\",\"/knowledge-medium/src/vendor/react.js\":\"4ec65798fef3e99a\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
