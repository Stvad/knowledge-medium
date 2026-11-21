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
		buildId: "06bda22219d9-d7f8844a",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"345f25f9fff2a1a8\",\"/knowledge-medium/index.html\":\"345f25f9fff2a1a8\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-DE0kZ5Sa.js\":\"7c073520e0787796\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"ed8f935ce41b0438\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-BWoeNZHA.js\":\"f72f5f4e7f47f327\",\"/knowledge-medium/chunks/FacadeVFS-CqKLyaMm.js\":\"a768f2b74bcef864\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-DYjGLEux.js\":\"71a35d6d3b6b00e3\",\"/knowledge-medium/chunks/MemoryVFS-B5Apm_Md.js\":\"bca515d4d2a084dc\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-5bVOhiJR.js\":\"5c6b7c525cb07ca1\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-CwAIuCpN.js\":\"69eab447533042fe\",\"/knowledge-medium/chunks/Preview-Cv4mPcyE.js\":\"a22b704d4bf806a7\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-BmZRJL4x.js\":\"f9bf75176f046733\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BMOxdLJS.js\":\"6ef071f4ddefef86\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-0D5z3PnR.js\":\"a0117c05675d8e13\",\"/knowledge-medium/chunks/react-BDqZEzRs.js\":\"eb8fc6143cc65458\",\"/knowledge-medium/chunks/react-BPyEPPEH.js\":\"d924ede4f884c422\",\"/knowledge-medium/chunks/react-ByRdqcgw.js\":\"88f721ad5e297910\",\"/knowledge-medium/chunks/react-CrvH-wNd.js\":\"09fff0a591d9255f\",\"/knowledge-medium/chunks/react-CtVeyEAu.js\":\"d12a5b5b24a07a84\",\"/knowledge-medium/chunks/react-DLGxfsX7.js\":\"bbc2dd812d8277fb\",\"/knowledge-medium/chunks/react-DZ8P-o-2.js\":\"c7ec10e62c1aaa2b\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-DllP9ylm.js\":\"fd7fe790e72f7bda\",\"/knowledge-medium/chunks/react-dom-server.browser.production-BKrXu_Cn.js\":\"704895e44099d7ad\",\"/knowledge-medium/chunks/react-dom-server.edge.production-CFH1a1RP.js\":\"c00fb971a2babc6a\",\"/knowledge-medium/chunks/server.browser-BaIa8cmC.js\":\"7b403b47f3fafe05\",\"/knowledge-medium/chunks/textarea-BpKW7djz.js\":\"ef108bd70851565b\",\"/knowledge-medium/chunks/ui-DicIMfp2.js\":\"26062282e80ea89c\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"8a50e257f27f97b8\",\"/knowledge-medium/src/appUpdate.js\":\"95a8064023ec8388\",\"/knowledge-medium/src/appVersion.js\":\"21d63f4b683381b2\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"a9e5e00ab940afaa\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"2cdae4003cf3dce3\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"e15e8875578d4c1a\",\"/knowledge-medium/src/components/BlockComponent.js\":\"b8d1807db5369882\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"5c6fc1a904755478\",\"/knowledge-medium/src/components/BlockEditor.js\":\"cc2b39b02bb49361\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"af02103da15d4bab\",\"/knowledge-medium/src/components/BlockProperties.js\":\"60fbcdd466d2c17e\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"7e48a17cbae46164\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"c72359b024cccaa2\",\"/knowledge-medium/src/components/DividerHandle.js\":\"5fe579e35d8efde2\",\"/knowledge-medium/src/components/DraftEditor.js\":\"bcc5b0a7fe8d02fc\",\"/knowledge-medium/src/components/GutterPill.js\":\"ff23b4e3ae81c7a1\",\"/knowledge-medium/src/components/Header.js\":\"c3015646fdf743b6\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"924938290c6aa3e9\",\"/knowledge-medium/src/components/Login.js\":\"f82d7ce938958756\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"137ea8fb41f9894d\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"25f772dd56410942\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"cb9410f7bd0ceaa4\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"b2beaf7ad1324d1c\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"8961c9c309da34f3\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"fcda03783b09d7dd\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"ec1bd32e4fd8842a\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"3d6f0444a485b0c2\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"e42d512aa9d9b0a8\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"d8d766a5b624cbdc\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"182106723bd4a561\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"2bc93ffa823061ec\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"b3a0722cf40b7939\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"096792fcf567453f\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"7c8114bd5cb242b7\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"f76af17fd1dc7935\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"6a955775dcdadcac\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"0fbb16f086a29494\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"bcc120eee8acf42e\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"b3c6045616126d19\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"a7527aab576702b0\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"bf290556aaa9a5d5\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"ac9cab0c3c5bc21d\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"259c65466bfbfcec\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"8fc0ef635cab90c3\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"7319dcc6dab2a05d\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"c1bb71bc04f1e707\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"5cda9a3c30c7431e\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"25cb7434972715f7\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"320d8114594d4d50\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"a64ba750727cec2f\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"73488016c6787bec\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"1bd43fc06389e17e\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"129b750a475f3185\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"2d3fe838eeb828fc\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"2845d0af75574e44\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"72265e68c779d41d\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"b8f1708edf52c02c\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"7ed4f4b35c1fc28e\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"01cf82bc3f386082\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"5a1639dea27b9ed2\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"833fb1daff43ed07\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"ca6e554edbf7fe50\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"585aef1305632b0d\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"26032dd342545069\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"6ee35002defa43a6\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"dd95ae58f8122027\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"0788b2ba459cac35\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"3599adc08c41046d\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"6ce7fff08a8948fc\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"69ad6b9343d0bb07\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"848a7054100d4f04\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"aa9b7d30d7e51d89\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"69f5956dfd32421f\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"3dcd8829861e27ce\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"484e66ba2e6ab88b\",\"/knowledge-medium/src/components/ui/button.js\":\"5cc972d73578f69b\",\"/knowledge-medium/src/components/ui/card.js\":\"151528054a7ca355\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"6398222ada181ac4\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"fb9c4944694ab09d\",\"/knowledge-medium/src/components/ui/command.js\":\"3479703328df9b98\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"6abbdd9d1f32bae3\",\"/knowledge-medium/src/components/ui/dialog.js\":\"6248c6c7a966759f\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"3d9983d6e95f4e4f\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"4f01cdbac6b340e0\",\"/knowledge-medium/src/components/ui/index.js\":\"cd43753c7c5ed628\",\"/knowledge-medium/src/components/ui/input.js\":\"5eb1cc6f6cbd3caa\",\"/knowledge-medium/src/components/ui/kbd.js\":\"3ac3bd986188733d\",\"/knowledge-medium/src/components/ui/label.js\":\"1bb24869ca001fc4\",\"/knowledge-medium/src/components/ui/textarea.js\":\"5cb4c6794799c302\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"f207247a0fe58b3c\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"5233d913bfe42089\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"e0388e0565a08f3a\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"0cbf57638c1625da\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"64a63bedd69fa7b4\",\"/knowledge-medium/src/components/util/error.js\":\"1f08c5fa0532f2cb\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"f63460ca30fe7e29\",\"/knowledge-medium/src/components/util/suspense.js\":\"45f9c63307b1ad5b\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"e1db92929b1cfbbe\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"928e045a2bbf86e3\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"3b9d4a24eabcec46\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"efdd16564897d558\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"7d2d593792bc4fc3\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"19e99555302c176f\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"dd378ea99b278e97\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"1ea3547253a7ee1a\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"289288288eea3d63\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"d2e2ba203c7219e9\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"2e1eee28a8ff4b4f\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"0b41269c22d62f9a\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"5d07940f6e0b21b3\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"9a7721474277ccdd\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"2aef3b5d2fb44699\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"6ecd60c68ad06825\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"664181fcd91be00c\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"635185eb33983aab\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"4a26354a9800dee7\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"0c3522a38fb775e7\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"01d26dccd354b203\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"5eb4b07ad960424e\",\"/knowledge-medium/src/context/block.js\":\"4b2495f6f3785caa\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"17869d053ffa31dd\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"b0745707f223c75d\",\"/knowledge-medium/src/context/repo.js\":\"3b1032e020e1994f\",\"/knowledge-medium/src/data/aliasClaim.js\":\"7be55ff78491234e\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"651e72a4280bd831\",\"/knowledge-medium/src/data/api/blockData.js\":\"37ba1845c463042d\",\"/knowledge-medium/src/data/api/blockType.js\":\"a0c2cb175ec907bf\",\"/knowledge-medium/src/data/api/changeScope.js\":\"6cec427c2249bb29\",\"/knowledge-medium/src/data/api/codecs.js\":\"5e0bf61d9e304542\",\"/knowledge-medium/src/data/api/derivedData.js\":\"2608b890bc28d834\",\"/knowledge-medium/src/data/api/errors.js\":\"a84b4b38d19fca5d\",\"/knowledge-medium/src/data/api/events.js\":\"d2f640261cedc44b\",\"/knowledge-medium/src/data/api/handle.js\":\"86e6885062198020\",\"/knowledge-medium/src/data/api/index.js\":\"ea4bf2f6e07523e3\",\"/knowledge-medium/src/data/api/mutator.js\":\"3253f6fe9b6d6d0c\",\"/knowledge-medium/src/data/api/processor.js\":\"ea1969b6d1ca39ee\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"b43a3a566b63df00\",\"/knowledge-medium/src/data/api/query.js\":\"b0f6c0789bc842c8\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"47e4bc13e87bfd4c\",\"/knowledge-medium/src/data/api/schema.js\":\"86e6885062198020\",\"/knowledge-medium/src/data/api/tx.js\":\"86e6885062198020\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"7e280beda802da08\",\"/knowledge-medium/src/data/api/user.js\":\"c8f3eb39a4a063b4\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"a8970e637c3833fc\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"e9bc2c6f0e669969\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"9234e42e814ff3f6\",\"/knowledge-medium/src/data/block.js\":\"2c3f112c6f15b5c4\",\"/knowledge-medium/src/data/blockCache.js\":\"63b6521c15efeb87\",\"/knowledge-medium/src/data/blockId.js\":\"6970089ec34ec9c9\",\"/knowledge-medium/src/data/blockLiveness.js\":\"1265f7002631c4ed\",\"/knowledge-medium/src/data/blockMerge.js\":\"244cfb12e7678861\",\"/knowledge-medium/src/data/blockSchema.js\":\"219fa4e2082cb12d\",\"/knowledge-medium/src/data/blockTypes.js\":\"5819bea01cb742a8\",\"/knowledge-medium/src/data/clientContext.js\":\"b2bf44d8f540aeb3\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"ac50aefca60c0fe3\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"29611ce19eda2606\",\"/knowledge-medium/src/data/derivedIds.js\":\"646aa9464f28f473\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"2a995c25598302a4\",\"/knowledge-medium/src/data/facetBridge.js\":\"dabf6dee2b94fb74\",\"/knowledge-medium/src/data/facets.js\":\"47d1be828979236f\",\"/knowledge-medium/src/data/globalState.js\":\"9d068a5ca44af113\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"af15c7d558daec4e\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"ccf7af2f82a32c4e\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"8b15b75ceb4d920d\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"476da848ced3a236\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"03421a64e5adda6e\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"1dace5ef068c5811\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"07837bb46bae589c\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"a3907ac30a436260\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"1e03675929c6dec4\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"a954127839f833da\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"b3050a60e5413d5f\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"2d56ac0c7f8bd4e7\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"7e6623eb47f17b7a\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"ea4b42a581c67028\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"a1544a6c06b3f222\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"03a096febd4f48b6\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"6de6d054b17bcbf6\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"7b7b4d17546abda0\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"061a76293c8d1df2\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"2820443ba56f6e25\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"d1d565a2d6ca37ce\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"bdefff2f4e7173ea\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"7d930c042dd559b7\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"681571273287457f\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"fd8dbcc3bdb3abdc\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"64e9fdcddcf84b49\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"11b4749f51e2d574\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"8ad67acfeb4e1fb8\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"ccf015c6443f8618\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"3bff25703d7ad544\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"e246312133d1eef3\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"fae6068617991247\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"fe8ed9b05fd705f5\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"d07ce8e0123fdaa9\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"c805552f613ecf92\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"170d18d6bb4bfde7\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"52ec278b8e0f3230\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"06ce97f6936043a8\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"e83b59106ac85454\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"7b82e24890f21571\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"d699c937735a0b31\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"cf1ba458c714242a\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"0f09c796d240d123\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"6f6010514454ea52\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"ebdf9d5dc8d3cbf1\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"6d2643b109b39f20\",\"/knowledge-medium/src/data/invalidation.js\":\"993a9034ae7e4b15\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"6d499c7a8e4458c4\",\"/knowledge-medium/src/data/kernelPage.js\":\"aa10bc635db5ada3\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"cd1d44df28d2d951\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"0fc4f745d674a718\",\"/knowledge-medium/src/data/localDbStorage.js\":\"28248755e3b07873\",\"/knowledge-medium/src/data/localDbVfs.js\":\"d20577d48b140810\",\"/knowledge-medium/src/data/localSchema.js\":\"03614eb04039f043\",\"/knowledge-medium/src/data/maintenance.js\":\"06aa1a523b2c24d1\",\"/knowledge-medium/src/data/mergeProperties.js\":\"566fde4d232b16ab\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"90bd1bb695e00e62\",\"/knowledge-medium/src/data/migrationsPage.js\":\"718b557ec2524818\",\"/knowledge-medium/src/data/mutators.js\":\"cfc9c0f00e758457\",\"/knowledge-medium/src/data/orderKey.js\":\"cfab8a851af5c347\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"e2c3f075523a6c81\",\"/knowledge-medium/src/data/outlineSurface.js\":\"8ab538a3fdf3c041\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"67b4ba46302562ee\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"946cff33f86a0cd5\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"a02cacf2ffa43844\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"12b36be90ba1062c\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"1414c872cc6473d5\",\"/knowledge-medium/src/data/properties.js\":\"a55634e2561d676c\",\"/knowledge-medium/src/data/propertiesPage.js\":\"189c097ad2620224\",\"/knowledge-medium/src/data/propertyChildren.js\":\"c4406edd2b819c82\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"f69a8f8f5c5177cb\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"2749038b52e1f85b\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"eafa45b56944f7e8\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"f33b0a5a18f0e75a\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"0cb460fc930a09e7\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"f07adadec66cd3fe\",\"/knowledge-medium/src/data/propertySeeds.js\":\"d4c93c1eabbecd1e\",\"/knowledge-medium/src/data/recentsPage.js\":\"921478be04aa7bd5\",\"/knowledge-medium/src/data/referenceBlock.js\":\"143550f809bf275b\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"189e1ccb292427da\",\"/knowledge-medium/src/data/repo.js\":\"e2f2d43e799c72e1\",\"/knowledge-medium/src/data/repoProvider.js\":\"9333286f5786d7f4\",\"/knowledge-medium/src/data/rowProperty.js\":\"86b12a655ec9cb33\",\"/knowledge-medium/src/data/searchFilter.js\":\"18853fec4e61f824\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"48dd568e41b6bb40\",\"/knowledge-medium/src/data/stateBlocks.js\":\"3bbf24f1ceeef13f\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"06f7a2548c14a518\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"934f902e9943a76c\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"22b4cf1ccb0626f4\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"2500960625674769\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"a4bada82d074b931\",\"/knowledge-medium/src/data/targets.js\":\"2da7f23de0b22dfc\",\"/knowledge-medium/src/data/typeColors.js\":\"f59061028b57e527\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"41bd862ed2f826a5\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"52d34b19ef090731\",\"/knowledge-medium/src/data/typeExtraction.js\":\"b0a8cc406e4f600a\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"6eee5b9360169192\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"8e4c07aeaa59f03d\",\"/knowledge-medium/src/data/typeSeeds.js\":\"8ae1b482a18adcb6\",\"/knowledge-medium/src/data/typeTagger.js\":\"34bf32fa7ad9786a\",\"/knowledge-medium/src/data/typedRecords.js\":\"df75d058162446ce\",\"/knowledge-medium/src/data/typesPage.js\":\"e732a82859016bdc\",\"/knowledge-medium/src/data/userPrefs.js\":\"d7ac4a0a0d51ddc6\",\"/knowledge-medium/src/data/userSchemasService.js\":\"ed91a8f9462af42c\",\"/knowledge-medium/src/data/userTypesService.js\":\"3b87e19e41f37a38\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"6350719c40a95ceb\",\"/knowledge-medium/src/data/visibleChildren.js\":\"a7eb704ad6dad077\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"2982ced9650f46fc\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"1aef6dfdcfd0baeb\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"3ad5b07492834a48\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"0e92691cd72b3b51\",\"/knowledge-medium/src/data/workspaces.js\":\"6101916ba6aa9cdd\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"45399bad55beb59d\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"d3ef953ec241bbb1\",\"/knowledge-medium/src/editor/atTrigger.js\":\"8dc1e95b4251ffc0\",\"/knowledge-medium/src/editor/autocomplete.js\":\"caa815a7edb8cb5a\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"6c887deab821b1be\",\"/knowledge-medium/src/editor/contentFlush.js\":\"8be003857db2a708\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"c37bd3a0c6b29454\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"08addbccede0b6a4\",\"/knowledge-medium/src/editor/insertImage.js\":\"89b2ecad12cdf369\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"239271ff9fe711a8\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"63dc395510f74ce3\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"1408be04d7c305fa\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"c0251b11a27fbce3\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"279a998791762648\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"3127e033354efc55\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"26b5ee89abbf202b\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"f40e154b755ad72d\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"4d754978b1e78742\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"eb3935dd84755f74\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"decd38055d357565\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"009740fd25e6f3cc\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"2cedb84ebb055955\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"c6ebdbb5fe95f560\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"efc1fc877db7c489\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"e517ad998d39ca5b\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"62ce3c82489e0abd\",\"/knowledge-medium/src/extensions/core.js\":\"c65451af4b77e824\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"22391c67168b2bff\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"85ed5af74ce5e61f\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"a22a874355dccfce\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"22b6c00e41213dbd\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"cdf6b89af1eda5af\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"66f13e23c3b5654d\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"b9de818ebbe6f49a\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"2df18924233d863d\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"0d3c6508b508e0e7\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"66558efa04de7c13\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"2960a2a21f204e7c\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"8ca361279bc6d45a\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"156b2d20ef4028f2\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"4e91e15b4960e6bf\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"372dbc95bf59a095\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"cd7bab8735532000\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"2f75a817e90cb539\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"ce4aca4377972572\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"27d16d000f00029a\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"0af2e184c800b50a\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"f3f56aac5c5c4b97\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"b6be758bc952de19\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"d8b67c78ae26af53\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"d12fd6aba73d8fc8\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"95c583349fb40b04\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"3c46560f1461da70\",\"/knowledge-medium/src/facets/facet.js\":\"22bc26b8c7123948\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"f1fdec221dff6a86\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"2f42251dd0ed2b36\",\"/knowledge-medium/src/facets/togglable.js\":\"64cda9570323c00d\",\"/knowledge-medium/src/facets/variantFacet.js\":\"fdc0146f8d66e146\",\"/knowledge-medium/src/facets/verbFacet.js\":\"d32fa0371b7db7ad\",\"/knowledge-medium/src/hooks/block.js\":\"3cd98d20366beb46\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"ef323fbeb8cdeac8\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"73dc6b4b0bd5788c\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"32128fdba30b4248\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"ee1794afaacacab0\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"a6824f2f79daa578\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"72f106b4512fd05c\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"bae45313abe435f3\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"37511a6450fea44f\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"4e4f8e2a03ab0237\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"222d08f710d33861\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"a7df4b1d8bce11b1\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"42810a637aceb45a\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"bc759149f6ec995e\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"b2babdf45848adb0\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"53a0a03757555115\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"cfb5befe27b2390c\",\"/knowledge-medium/src/lib/utils.js\":\"b8eb03768320703d\",\"/knowledge-medium/src/main.js\":\"77d6f67afa0d1034\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"c69271c8e0ca9563\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"448acf82ce852577\",\"/knowledge-medium/src/markdown/context.js\":\"be6040d6705be80e\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"90c1684ac4e821eb\",\"/knowledge-medium/src/markdown/extensions.js\":\"8042b51085a233d1\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"6d1290c328653a00\",\"/knowledge-medium/src/minimal-editor.js\":\"f2efd86c9676a593\",\"/knowledge-medium/src/paste/armedCut.js\":\"a7c2d776f19b7185\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"552900ad802697c4\",\"/knowledge-medium/src/paste/clipboard.js\":\"1d68e389fe3f4cec\",\"/knowledge-medium/src/paste/decision.js\":\"ede6204e0624940d\",\"/knowledge-medium/src/paste/operations.js\":\"2800feb395178dfe\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"7f4b50f4efe9f04a\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"8185775f8293257f\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"e59a455f4fc55199\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"41f54de4a08ae99f\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"fe12265dcd0f97b5\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"4e0d053f68a9d1c3\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"9cdb0de40182855c\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"937bd452122434f2\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"c9412d79cd561915\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"005fd451ebee87d0\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"d141bd3c1856b451\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"2cc8de5444d79426\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"cd7ca5691f50cef7\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"6e015d0b3e579424\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"5a457bc0f38e1225\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"4496ed9a6a33e065\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"78109f3c657d5add\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"06bb356cd6f0976b\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"86225d016ad8449f\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"da891cbfc6d3004b\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"552ae7a22b133c89\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"e2ca81fee7aa8b87\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"e467a523c8f22722\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"d6940361810bbdf2\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"a8396484a17ae52d\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"d40f4bee80a29d1f\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"f01b0ef017bc8651\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"5736f54bdaff8776\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"2f2eadf286c2c209\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"67a4eccab4025a30\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"94b9f50d17aa814a\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"e9a19741efa22e86\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"ff2a9e919740fee8\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"a04822f240cac9d2\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"484849c374c0fa60\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"a7dd2c207b3835f9\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"2ce68f7604c94679\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"8a0e9aca8ea7523f\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"c0ddb164b67193b6\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"ccdd730c1e2e1458\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"b21279837ce5a7d6\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"171a510bb4bc40b2\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"6694116e094cef01\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"629b010ca1b0d80b\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"d7250a9399cedd34\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"9cbb949eacd23c95\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"e242a05497c917b6\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"cb81de6bef6309c9\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"4305bac6e390f25e\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"beeb3c2f2a9d10ff\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"56dadd5ef1fd9bcf\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"473ef7917b60e75a\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"973e97ff30fa633d\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"5d3c68638c4edeb2\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"31d11a3d1d715c02\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"0aaeb129ecd52918\",\"/knowledge-medium/src/plugins/alias/index.js\":\"23fa5694a841bcc8\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"8fefc63d1417534a\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"cdea6f77c3cd650a\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"836cb1907e539528\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"311edda74cc40e49\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"949329639f4aba20\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"6c71a58fa5fde336\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"6b2edc5a27c42ac9\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"da3aabe7c073a244\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"e929292159f64e12\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"75e525f767c8c889\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"098a418b577999e1\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"32f4b1e152885d77\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"be74842556e9ebd9\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"ce197352260bb7ef\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"a51470feabc474cf\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"76950ffc49f8e241\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"6ab7b0370684a5b6\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"ccd1bbd60bc6a1e9\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"3f44ccbdd57a06f1\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"e1f7a9440f6b6cc9\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"957aad07b2ba4ca4\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"bd7433e1da72fe1c\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"75cf57128b2f54c9\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"d08162be52f4d7f2\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"f41a586c890aac92\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"2d9f68114dd069b8\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"73520f5cd6079bbf\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"822a1fbf14dac7e4\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"ad25b6b7323ae5fa\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"452ea2af24c1d642\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"a937b842db425d77\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"d9afc299eeddabde\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"8946d237d944bbb5\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"e9d905e558a8ab94\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"a4069880e3a9261d\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"d794adda15f88b9a\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"7056298f63ea2798\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"f918cb5ab946485e\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"520208d93e0b3ab9\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"30b8b094e7717f37\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"461aa18fa3f0d075\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"f58daf3c062c6cf6\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"3c90933600c3ae72\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"d54ffc8061a0d160\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"fd0cc1afdc49989d\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"c97f97b994b26925\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"df669678240fd623\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"f7ff284893910158\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"3af4166c08e058f8\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"80ec50a3b8018007\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"7fdb1304f104d927\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"2e0a0734a97e94eb\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"909ccc19165b3ea9\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"3bebcf3efaf18ccb\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"579e961e48f05185\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"53854dc54eacefd6\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"b7724f432bc52c28\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"a8d19004605287fa\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"af51967674ed3a15\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"0f843cfad380e646\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"23538bbefca1af71\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"9153711471836a45\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"f6717e7874aad6f4\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"05f436d0b2ed0694\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"6098097ae897171b\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"d4d67c05d4e70f28\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"cc3b19f80df212b8\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"4252b9870c1ad2ba\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"918a5f3e8784d71d\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"d04ec44bb36598bc\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"e0cbc1b2420272bc\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"04976a4d42f9a204\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"d1dd855664b0ad8a\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"a598158c2271d45c\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"b021f82a69f3b5b3\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"a51804a8938bb32e\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"d9bc6f206b2ab758\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"c767476b2695742c\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"38f676f671d2ebba\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"3ecf0fb80a154579\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"b50815232a54f454\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"fae764187000645b\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"b279d3d1fbb55a85\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"74285e3e3400e954\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"52822a66a0f289b2\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"8660b79f1cddbc53\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"36415542f54f5af3\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"0cbdd2c0a9344045\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"80af77e054b7c32a\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"297ceb522c0b631d\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"b87ef973c4c046b3\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"c3f2c8196f76b109\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"de8cd745ac111458\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"06caab8a04f7927b\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"a5d412790c1baeec\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"227eb0602ad82b9a\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"d20d371cf6440e25\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"b7fefbf4849e4c47\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"e0d56aa1a84360c6\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"07870abc1d441d2a\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"636f02d3dc58e90a\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"6e182b4865b01cf8\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"d545e3750337f320\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"34a93b30f8251697\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"0b3b8be4c5e7d5ba\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"a0403ba3f51bb075\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"5f71f828b078e6d4\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"8d518f2d903bc4a6\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"5edca95e6cea6dc7\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"6f311d190e1c1995\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"9325fe2d01f29cd2\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"68b4d52338913165\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"29f58ccfe2f13777\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"d1f3163118b7176b\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"c6f9fe9361013399\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"91f6c372cd32a17a\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"e24133d38607f1ea\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"dcaceea4ed8ae4b5\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"52a864c89d08a007\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"feaafe8512f131bc\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"0ed1121525adf3c4\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"2e05000b0682fd82\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"c601963bef4d3316\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"2c131f75c464bb73\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"7d336a71fedd955a\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"5ed0ac7e3a75e7b1\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"3af7e289b3159ac1\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"750daced492d8011\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"0ae7d5a60787db78\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"f455289c8d624b05\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"0fe6fcdf40843877\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"e8f0a367ae2e380c\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"faa3c46d3233badd\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"36dc62873afee5f0\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"c883c71198d929b8\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"b84bbc2aec8b4a97\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"ac5e7a1930c1990a\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"9ee4f21ba77b204d\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"c106a7e060772e60\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"b55f21626bcaac76\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"b0600bf8f0ece714\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"514564d379b10eee\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"e9e473e1006fc743\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"9c0d392d7cdbdaa0\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"0ebb7e7c6f45bb8f\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"1125d46a73964a09\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"d2e222dd3705fdb2\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"c8179aa384a61892\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"fc9c1023eb131d41\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"c2b988174b0f8501\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"d71d5e094966bbd6\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"372abf0d9c0851ef\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"ba5c7d5fd72db89c\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"9ca0405bdafd8414\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"c48966c33bea4729\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"26acd4d183f61b09\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"778228793d8bc937\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"c9cef5fc886449c6\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"f967d748b3770dec\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"cb04518a24fadb23\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"3dc284f3713388f6\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"2dc04fa9345a0887\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"c1cf96ce83284135\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"a064c3f933dbbac0\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"b314c322a3f7d660\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"b7337f6f2a940c55\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"1c1e1f75167ec5f5\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"f86e78003d690899\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"9bdf7c9a99961005\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"7be72de7480b431e\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"590d6de338feb7d7\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"d0983237bb5ffd81\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"4cdcfa9fa40c5ebe\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"7a7cf12399cc2d50\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"9237bd8427f42678\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"51518ec67ece69b4\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"d9409ceb19383ad0\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"b6d6de49b921fc43\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"4279f6850262b98d\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"582fc884dbc6d95c\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"b415f106475d0d80\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"687d385fc16ce6d9\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"5eb8c16d8351e73e\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"370a715b08655e8d\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"0d27c0c16caad8f6\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"077b18c15dd10f72\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"d3a2e5991b3bc82f\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"c9a2c8707e030da6\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"7d6c202c7aff1ecf\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"4e49c0576ee00cdd\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"8703290a2d960d67\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"25e78e90c887ef58\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"ed2484280e8262bd\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"848596c9222708d5\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"ca59f69e8ae39bd4\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"fd20261e37ddc4ad\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"e6a246fd0fb48ee7\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"8f7be00ed0543138\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"9686cf7b2e375532\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"a0fd49213f22ef0e\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"7dadbe34af110cb1\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"7a65fe9cf2e84828\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"9e8f61e6dec28049\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"b4385fb58c454925\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"71f2e5373baed462\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"f857fd308bde4869\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"30522512f08555a2\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"dcfd5472b8d98081\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"a2eb1b341484445f\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"b16ad82128ca3330\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"9dfbec0ce1713367\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"b337bf043642a1be\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"118530fc757e8a96\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"c8000d67d59609dd\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"b3e3ecae96aaaa6d\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"f9950dfd751ffbc8\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"09ae239c9d83861c\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"838ac8950cc23722\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"1e0f9254dbb0ab6e\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"2ad42c0e437666e0\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"5125cb75aca587b8\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"2b9e012fa76ef524\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"90f617b71b25dd72\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"5580ef5eaf12eb19\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"64e7af2fd365ce43\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"4f394e2521c77ccb\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"7feff98c66e951fa\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"ec91768932a7a6db\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"811eabad930e4cd6\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"684f98f45d4e9769\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"fee2aa02ec4ff423\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"935b3b382d769946\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"a347ac6c24866948\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"17c06ab15d5e653f\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"aa45b4f0d23ab7fb\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"8ac24d1f4225af19\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"8c2bfa47f849e9c2\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"23691e38906f5d82\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"930b1546e39fa841\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"3e8c69c79ad4a128\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"2345a2bd87bdf756\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"b3058a5d8389a58f\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"39bbf8565b2dac0d\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"058479c7f9ec9dcf\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"fbd1ed027ae04030\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"88add78b07d38520\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"e0d073cf2ccaff33\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"60d8b183ec7fa2ee\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"43dd74fabd8b9fec\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"6c98d5434f2a6665\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"1c2b03e053dc1ff9\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"e78d4e588f3fb771\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"606bac9d1f9493e7\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"36ffac535fe52123\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"59be86f3f30ad96f\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"ac285041473778ed\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"edfe04866f7ac8f0\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"11196a309658138b\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"43aad38b94dca568\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"60d2acf3f0a07052\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"caa09664684f2932\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"cb66c20b29ba066c\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"b213c87ef51bc826\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"24ce216c82722130\",\"/knowledge-medium/src/plugins/geo/index.js\":\"d6a54c68a3bd7fcc\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"774745796ea13a1e\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"600380ba60f34750\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"0ee336c01c9d3186\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"3169c4128408b517\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"5c809992447a3289\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"d222b5771f2a5ba2\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"678f153787473314\",\"/knowledge-medium/src/plugins/geo/query.js\":\"da47bd80b047a099\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"742b4329c260a818\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"6757803cf2c78420\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"0ab39d021dab857d\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"c62b6db662739174\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"bac7568e1c000306\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"6d76bb00bf33d17e\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"4764ae7eacd95356\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"8924948f0c7c41af\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"15fc57e0ffa0322f\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"6fab23f644ba95d1\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"ac1deb8d940e81e1\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"787f3704711b24a4\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"502cfaeb2d00e965\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"e660f599915bcaaa\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"4dec3ae222c6a426\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"8ee39ae2a6693a6d\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"11d10a9bc3b36c96\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"b2e1c6b1c28806d6\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"11beb281dd70b690\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"0962c5bbaa692764\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"428dc7cd7ad61bf9\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"bd642b074393c130\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"25d66568ae32671a\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"8906dd18c9cff0fd\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"19b3e9ac0e928e7d\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"6d39f016c5a64c81\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"7440318dd064261a\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"9c6ef0df9a8bd45d\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"ad09fef59087dc36\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"54eaf6b5586432d5\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"9ef431bc16864c51\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"275fff9aaf634312\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"4a8a1df61b262acd\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"b2d165c4bbcb366d\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"38b88555e91101af\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"7d6940e41cf2a298\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"3f04583836657e20\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"95f9f5cdf28676dc\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"3fb5a6dde044bc9b\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"910ad99c646ed7cc\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"04cb932b2eb04d2e\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"336ed6c88f890307\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"b451c979593820a6\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"4ef8db6c038a2db4\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"74bb668ef3263d2a\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"45ea190e9ada3be1\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"7754e02be0905e62\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"47a3ef834bb42c48\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"05c52d873c6be5aa\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"9da4b1f1a035281e\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"d61750ab37618243\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"8cfc4c3111bfacae\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"b7dea3d1475be9f7\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"c8fdc7aee90f4e9b\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"59d52869b2bffdec\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"a6e68a0c5275b0af\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"7ce3eda245eb2a1e\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"c19b52ac9c3c6843\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"109ac656d0aa5043\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"7d6e8270bf729891\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"c53133124631eec9\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"e6260b6ebb55f279\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"126bc0c1d0978f29\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"00d06bc2405de38d\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"c88bb1cd0539a2c1\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"7fb6dbccc140549c\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"8470eba6e0b5c654\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"1a689a31c6090bdd\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"186b0f39746c0759\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"6b64cf30f56684a1\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"342f6a7959227180\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"b6effcd0e567295f\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"56c7d1fee1d44c43\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"d1dc09b265a88b48\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"fe23df9513480587\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"0aec3023cd830471\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"ea0afd1720592e27\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"4a4ec0420682fb15\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"47dbde2e68a8abd8\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"1df30d1e14fbbe9f\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"0ad92699b4214885\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"b2c728059462366d\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"3b83bfd0df29b0fa\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"4c63895efaecde80\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"19e0b19db6f7b1eb\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"f9c371188a588bf8\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"6156896d32bf6df9\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"c9e64d05abde94c5\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"dc244c6f48c5e675\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"e435c650e499b8b4\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"917b35b42faa489f\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"c731bc3f13abe2e6\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"12f46a7d5bb65c37\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"e10c7901f963a8a3\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"73fe27a2685e37f4\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"dad905c935742353\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"92c93e8361167047\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"19cde1f347895b8d\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"4f2dd548200a3819\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"3eeb305fae2d3ec5\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"84248387b9f831f5\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"ba09795d05b8bbbf\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"de907ba9b8e16f52\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"176e8e574dab1637\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"92990595294e0250\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"9df37885473cfcea\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"143f936a9740a1a2\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"590d1663f9535b46\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"0c81eb8a2fab54d9\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"db46ec0190a8fb61\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"4e68c9202d3f8e79\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"0dc942255fb42a94\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"6455ed1da9b98b3d\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"b8327252e67d1657\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"05ad9e84e867358d\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"a50ecd0d69bcfe5d\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"92d4602379df4032\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"377017fc79084ca0\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"47bb867058ade8c6\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"e09fe25c3aceb04c\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"916c03eb18204169\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"4cdbf14e22b5de68\",\"/knowledge-medium/src/plugins/recents/index.js\":\"249d0f1141ed00d1\",\"/knowledge-medium/src/plugins/recents/target.js\":\"c13565564b25ca6b\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"6e2bf4058062a176\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"9779578569840655\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"0f0a0504a3b10ebc\",\"/knowledge-medium/src/plugins/references/index.js\":\"afd16152a86e472f\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"b97f38438cfbd470\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"2014092d36f491cc\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"22a6c78ebe9eefdc\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"ca97420b05c3354d\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"ec4ba66f5a3e221c\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"6a43f987763c3d68\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"1b4883dfd767bd23\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"8e26cd509f499d3e\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"ad4886e893a4e7ac\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"39cf4754c3483976\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"e42738f884d61b42\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"3485b1552014ee3d\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"adaea5fb3e9af51b\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"b219d26744c60711\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"4a996241fc44ba46\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"eb6ef49f20d61af2\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"623ae507e69c624f\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"a1344237ee7e5174\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"b6abf0c80dd4f28b\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"a2ab5489657f40fc\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"82193ab505bca747\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"5be638e38c2793f2\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"d1402619de394b5f\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"4f36a74bfcb12e75\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"f1d8ff5496d18fa6\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"44f306b763a6ac11\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"474f12c8972ebcde\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"82c8c32209467c68\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"865242a2d8d7be73\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"faaed7e92826827d\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"f199e41c486ed4d6\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"557d0fe20b0e0dec\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"fc9384e13478c348\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"267fbdb4bca68dd6\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"3237bd145d99049a\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"9993fe7edfa9a6b8\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"85640887bcea8c54\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"ab88f11609eabb9a\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"1d39c48eccd3e117\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"60e70e305e672115\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"a044e4886f1b9258\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"c6ad31bb61206f90\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"35cae61277d9b0fa\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"5eddba7aa2d5903a\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"6b368cad6782f257\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"93831374584d6961\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"0dcc76d90e063292\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"376946d897d42187\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"4cf39fb526fa5c7f\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"7696cdaaeb3db477\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"89c975f10f3e0122\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"ea1f84c37b777ddb\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"f81a3c5c842ef92a\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"b303603a1e62c179\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"5c5948915c6ec452\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"3a78ba78bad27b47\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"0ea367326d18dd6f\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"068206f18e2fcb00\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"45ff60d11adca3eb\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"a17cb121058e3e87\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"3fbfeaeaee05e90c\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"03f21a7a43c1f774\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"7afc38e57fdc0f35\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"0cdc7a792c2583e4\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"5dcf3cc5f1ee2890\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"d0a78c2c0c42c06e\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"0078f1c443d99c7d\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"e978007d36d40631\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"19641bd2f777b6f3\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"2a3712e5443d86ea\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"9236bfd4d9314101\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"8ca7361474e4d6d2\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"0f5dc56397b2db96\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"7d79c9dcff3cdf57\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"3fc450792254c154\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"df2b5abed47fb392\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"a11b9e8d882df1b3\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"0c52663bace48499\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"8788f99997d888be\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"4ef5f9025479bbb6\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"8f29823033b45911\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"884e7cac3522e455\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"92ea56b62e9ac88a\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"1444d7ed71dd99c2\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"afb086cdfdc54264\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"15751629c5114e34\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"510b3fa76ef9569d\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"882bdf2d9d3b92b5\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"390e690c2c4b4e69\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"df3d411aff5130e2\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"bab99ac7928db3c0\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"fa85719bf1c9f22e\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"27a0682842050c4e\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"7e7d9207a5984358\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"70557f06044ff257\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"82ad50811261eea1\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"8e54afe32bf26fad\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"1b86943e95921719\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"98cc81fd119fd114\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"e105971d6f1156c2\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"db3d33b83804ce30\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"0e55282876a70cde\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"65ec791dffff2e61\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"6d8b1cfa9fd46ed5\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"e4b817ce09f95a8c\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"c260d2e044c239c3\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"f74904634efea6bb\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"a56de708ea3dece8\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"6c1a8e85cda47ad6\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"fb6314263bb357d8\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"d3a1c1c201cc3d80\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"714648e5afcd0026\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"4d9ea93c42931136\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"8d9ace349274dd87\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"bc3aefbf5732a62e\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"68e0ed67793e38d3\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"1a8b3bec3f0afd3a\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"a42d9c94142bb84a\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"6c3ae3461c0c1074\",\"/knowledge-medium/src/plugins/todo/index.js\":\"5f9fa4323b8b4644\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"287043d4ebd93114\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"299baa0b96ddda1f\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"43ef0d708fde250c\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"e2c727727dfa6fdd\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"5b17d3d4e9e5adc7\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"c48c7e04c7d1ff51\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"6f473f7e41d6e781\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"cb1e15128091bf56\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"67d8dc4799433981\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"b9a4f62a0be97879\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"9eebc442b7d6984d\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"a43a9f30ce2f118e\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"39a1344d1696dd29\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"925a76820f58634a\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"49a29a2c697d7f53\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"b30a335b4b58042d\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"56e8e730df8daf55\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"172e0b8a4a21884c\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"1b2e84d2949040f4\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"8698adb9344d0a7e\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"5fc0e829ec3715b3\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"857ef7ac039403fb\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"9965a36969e7c09a\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"9a733f3fde815299\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"54ee155326675c66\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"a6fc7f0bfa2a620e\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"5725c2a21e9d9fb0\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"4b0019e81c5d4d87\",\"/knowledge-medium/src/registerServiceWorker.js\":\"dda841af9146d281\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"cb6c9a3869acd6f5\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"48097180f4bf02ef\",\"/knowledge-medium/src/services/powersync.js\":\"34b84233586ef319\",\"/knowledge-medium/src/services/supabase.js\":\"ee2607505bb61fb1\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"f805584117818736\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"dd43e18befe1e6dc\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"689a21f8f54908b1\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"f95a2a3e2e395cd9\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"0ca7b0a64dcff353\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"ca55c4bc4a8442b2\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"0fc6d2538064b80d\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"06f65703d285423d\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"f5f1fdc7bd201fa2\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"aee858a022be9b54\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"1a2fa14e09dd5878\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"c57d3dd682519439\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"d7c005aabb49b7b9\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"5ee66d38decbffad\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"822103cf06c047c4\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"f20ceb4535c43f3d\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"2f1889cd0fca6e1d\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"ff3c273a0519d87d\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"b14be02b3bebdb65\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"8b0a60594c3c7ab2\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"f220a4466911b1f1\",\"/knowledge-medium/src/shortcuts/types.js\":\"5c75968a3d3a59a9\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"f0c8a07df3419674\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"eecb91317016bc83\",\"/knowledge-medium/src/shortcuts/utils.js\":\"26a59353b9cb289d\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"172d37d7b97f2700\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"b7f1ca1103cbd252\",\"/knowledge-medium/src/sync/byteTransform.js\":\"5e9b95a84caa2d78\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"ba75f74bd47b92c8\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"65477c6285660793\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"1dc4b82b7e578a54\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"249c5f0c89a6df4f\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"bbae7c33903bf9cf\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"0e1130c371604e01\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"47dd258a617ea9b3\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"0c0d8257ed2911b5\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"0042010ab94beb35\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"d7ed6aaecffa1a5c\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"056e9249daafbab3\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"a205bd3dfdfd1cc0\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"c654be1a52a7a766\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"76a1fd3e4bb7923c\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"3d09111852ecc9bc\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"580d60fe5a38f4a3\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"f2880e83adb391e9\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"a383fb2ee58acb68\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"3dbe0719968d7318\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"b06e202e2464b1f4\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"8f1e7f222b598d97\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"e762769448744724\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"18d745618f224587\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"11759b054c59871d\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"05c23bdd5aefe47e\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"4d649940cd1b5e75\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"947f4b7607042a22\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"5068db545aa07706\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"a1248f9120595f15\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"ee8662a1fcd8d6b2\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"2087bbf8b67f0260\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"e0d15001bbb63d45\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"6c9c0ff0fe301382\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"667ec423bcd7a4c1\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"8401bd00dad5e66c\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"17bd43b0707e8d21\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"447962ccb6dcbe68\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"2fef3e21a6206c7c\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"f24808864f471e71\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"51c477cb4b54c5f0\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"918b6f5c5ba64366\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"2f0c5056ee47a302\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"65ab81f235dbe48d\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"f02fd8f437f20f36\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"67d657ccb1223db5\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"6b439b4bdc1093d4\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"174f59d8a6b00d28\",\"/knowledge-medium/src/sync/transform.js\":\"52e01e795fcbcfd0\",\"/knowledge-medium/src/themeBootDefaults.js\":\"bd017ce7af4c4a9b\",\"/knowledge-medium/src/types.js\":\"952258b7da5f5351\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"991de144b8ada616\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"fd077058a113f887\",\"/knowledge-medium/src/utils/array.js\":\"ff537c6f38eca6ec\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"968263dbf113f497\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"edba25490e90f171\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"595209606e81e3c0\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"912ac5845c2905fa\",\"/knowledge-medium/src/utils/callbackSet.js\":\"f41ead37e0b7f1fd\",\"/knowledge-medium/src/utils/clientId.js\":\"b665b278f2e2971c\",\"/knowledge-medium/src/utils/codemirror.js\":\"acd2e764eda6772f\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"e8735cd9db508072\",\"/knowledge-medium/src/utils/copy.js\":\"cc1502b2e9540c09\",\"/knowledge-medium/src/utils/dailyPage.js\":\"8f17e97c1a188b4e\",\"/knowledge-medium/src/utils/dbForensics.js\":\"23a0a832a866d48d\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"ced88a1cd408068e\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"8f43368bd87dda31\",\"/knowledge-medium/src/utils/dialogs.js\":\"42424457ad64bdcb\",\"/knowledge-medium/src/utils/dom.js\":\"464c8d4b9f8f2273\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"ccf4e22df0f93e32\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"83577b44d696965f\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"0ed37bb2c8f5404b\",\"/knowledge-medium/src/utils/flipSlide.js\":\"b92015c3b9967cf3\",\"/knowledge-medium/src/utils/fnv1a.js\":\"a88c10fbb2c6e04e\",\"/knowledge-medium/src/utils/formatBytes.js\":\"e9f4c0134201afd1\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"340f183520ce6f18\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"aabf8da1104caa4c\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"b6b226fc6aa4ae80\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"0e7c775185a71574\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"356fec7cd20e28ac\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"fc5323d17763633d\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"594c8c2af38091b0\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"ed16ee46ab019665\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"8ac02dfc750655a7\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"0ec2d0e15c6cc34e\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"2ae9bfa640b12796\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"ed6907ce69d886b7\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"1d5f20d50af7b820\",\"/knowledge-medium/src/utils/markdownParser.js\":\"ebebd2e4c1a90504\",\"/knowledge-medium/src/utils/memoize.js\":\"e96b3c98b4b83dd9\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"82c3f7e9d2b714bd\",\"/knowledge-medium/src/utils/nameList.js\":\"b1b408373e39f2e1\",\"/knowledge-medium/src/utils/navigation.js\":\"51f53e770c757d97\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"e6b8a5a53482ccda\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"4f1ebc9c1403349e\",\"/knowledge-medium/src/utils/panelClearance.js\":\"273f70ab974c544e\",\"/knowledge-medium/src/utils/panelHistory.js\":\"87c8a81c2ccb6a27\",\"/knowledge-medium/src/utils/panelLanes.js\":\"784a4876df23331b\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"1f8c780bff46dff7\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"c1dfeafe4c6138f7\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"f76fac4924566a53\",\"/knowledge-medium/src/utils/platform.js\":\"815836e43c79d887\",\"/knowledge-medium/src/utils/pluralize.js\":\"0a31fa9dbf0d8f45\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"c687ba0f9d5584a7\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"281a0cbf0a6230f8\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"91610299e089b896\",\"/knowledge-medium/src/utils/react.js\":\"60631c1b2f6d34d1\",\"/knowledge-medium/src/utils/relativeDate.js\":\"a57ca1fc152cc0c4\",\"/knowledge-medium/src/utils/relativeTime.js\":\"35fb7dae398b8843\",\"/knowledge-medium/src/utils/renderScope.js\":\"f00d2e8bb5356981\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"aae4a18f24d66ffc\",\"/knowledge-medium/src/utils/routing.js\":\"2ae8bf098199862b\",\"/knowledge-medium/src/utils/safeMode.js\":\"c0c9017712d66d4e\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"b711e75effca42bf\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"e314b458ee3d82c8\",\"/knowledge-medium/src/utils/selection.js\":\"85348bcb0cf18349\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"c636371681961c0e\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"3a8f8cd120493ad4\",\"/knowledge-medium/src/utils/state.js\":\"f733b460635ad87b\",\"/knowledge-medium/src/utils/string.js\":\"bb7b51db7a578500\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"98a002470dc59dd1\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"d0aab6da6842015a\",\"/knowledge-medium/src/utils/toast.js\":\"aa5340ff8478379f\",\"/knowledge-medium/src/utils/toggleStore.js\":\"162b33fba7068703\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"540321d5ce46b015\",\"/knowledge-medium/src/utils/userActivity.js\":\"b2a2fd422f4cbb61\",\"/knowledge-medium/src/utils/viewTransition.js\":\"8e179e8fd705f69c\",\"/knowledge-medium/src/utils/viewport.js\":\"f11b7da2c424199f\",\"/knowledge-medium/src/utils/webLock.js\":\"680cc539f6c52ec8\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"ad7b31fe987a5b82\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"dbd559de1adcf557\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"c2275fc87b703710\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"f47927a9c42cfeef\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"b4dc7632d5f81ead\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"be529e3d74e30b9b\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"2c94746e5fd605b1\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"8af3ca7ee3f8b6cd\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"10f9c1f40f2dc8ed\",\"/knowledge-medium/src/vendor/react-dom.js\":\"265696c992587a51\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"7a8bfd3ef3bd86e6\",\"/knowledge-medium/src/vendor/react.js\":\"9fe43372732e32d3\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
