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
		buildId: "1f2f65684295-819006b5",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"be148c09dc5db967\",\"/knowledge-medium/index.html\":\"be148c09dc5db967\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-2aFIfWdl.js\":\"7b358cd0feea4542\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"51cf40bee8b50beb\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-BjnTaIZj.js\":\"67b32686fd8fefdd\",\"/knowledge-medium/chunks/FacadeVFS-BCWQPXAZ.js\":\"01d1831fdbad4bdf\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-CWX5xvyU.js\":\"4c673466cf1d4e82\",\"/knowledge-medium/chunks/MemoryVFS-eX1OvL3B.js\":\"40c03e52dea30541\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS--hBYHphT.js\":\"f6ffa8a075070ef7\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-BCCUCC1A.js\":\"8e0a5d7cd8fb4aab\",\"/knowledge-medium/chunks/Preview-BX00D44Y.js\":\"241252379af246bc\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-Bijrax7V.js\":\"c447998715eaff37\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-DmVat0HU.js\":\"8a155b1c97c1cf3c\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-B5XV-dFy.js\":\"10647597ca533f42\",\"/knowledge-medium/chunks/react-BQf-Dus5.js\":\"2f81d227990fc0ba\",\"/knowledge-medium/chunks/react-BfThXpW4.js\":\"6344cabc9f4177a8\",\"/knowledge-medium/chunks/react-CBlwEDuL.js\":\"fbde5a293ae41a01\",\"/knowledge-medium/chunks/react-CaXuFhNN.js\":\"0367017fc3e5e243\",\"/knowledge-medium/chunks/react-D2dFTt9C.js\":\"d00d3bc5ce8fc391\",\"/knowledge-medium/chunks/react-Dl2Hjh-9.js\":\"a0da8ec1370f9b18\",\"/knowledge-medium/chunks/react-apbERVcE.js\":\"78bcca9adf4c6ebc\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-NsSDtmAq.js\":\"e9b3bcc4c6725564\",\"/knowledge-medium/chunks/react-dom-server.browser.production-OwiEQX1j.js\":\"d7b643d5e2e17228\",\"/knowledge-medium/chunks/react-dom-server.edge.production-CA9iAxX6.js\":\"f5ca83c527224562\",\"/knowledge-medium/chunks/server.browser-BRIJywOf.js\":\"5c1efa176b24ae4a\",\"/knowledge-medium/chunks/textarea-BKoV8Ro9.js\":\"981045eb375e01e6\",\"/knowledge-medium/chunks/ui-B0i800E6.js\":\"ec8a17d41fefc906\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"4393c6d29c18e2f4\",\"/knowledge-medium/src/appUpdate.js\":\"a8bb0e4124898623\",\"/knowledge-medium/src/appVersion.js\":\"f8739156dcf37459\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"825d72c8f313799a\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"0cb2ceeef3f40937\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"d8137c1909d0e7f6\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"4daf2aa97801e955\",\"/knowledge-medium/src/components/BlockComponent.js\":\"d605b15276bf438f\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"bbbd0c1406e15454\",\"/knowledge-medium/src/components/BlockEditor.js\":\"dec505769b95e135\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"e6d5f6034cbb5a9d\",\"/knowledge-medium/src/components/BlockProperties.js\":\"c5f97b98ab2159ea\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"69b8138f8bf0b500\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"b9157154d9c1de9c\",\"/knowledge-medium/src/components/DividerHandle.js\":\"4d346db8d3d1a834\",\"/knowledge-medium/src/components/DraftEditor.js\":\"516192edba8896bc\",\"/knowledge-medium/src/components/GutterPill.js\":\"af9658e432121096\",\"/knowledge-medium/src/components/Header.js\":\"082d9a9b12709316\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"d31a1b01e76498dd\",\"/knowledge-medium/src/components/Login.js\":\"8058d0734d1b3a07\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"5262d36ebe964dbb\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"1870671057b6c2b7\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"e3d9da577f517b50\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"6cccea89211692c2\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"6be082293c956631\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"8fb919c920b20301\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"cc545c7fbe92de75\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"78ae869a0275fe6e\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"b3f4eac9e0a47f35\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"98a268bb16d616e7\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"e838d4f2756bd715\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"03205e49f3fc7a6b\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"b8de421c92641860\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"cb6e438e899b1f49\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"1d267df0fc887c42\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"1b83999dfb687165\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"b41f7c07777bf066\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"149da1dc5ce2a3ee\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"a66fb0a23d8fccf7\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"a417e3a801f8e6b9\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"a754ac38e375ce8a\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"879ad8743cd93ae9\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"c371db9b34f87e96\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"95a54d43af379d54\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"1a79cc56387303e1\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"bd9b50febc388614\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"07436967a5e14ae8\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"fc91713da3aedcaa\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"dece2f7406d82d6a\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"bcf8391cd1f9e4df\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"ac3d543cff78470b\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"cc5929153e539996\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"d6e31883e5b1057d\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"c5e60b500926eaca\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"84d43504949861a9\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"02780e8706930c11\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"1c0f5aacac1ce41f\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"c2e3abd0df7daf63\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"294cff27c17192d7\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"bffee4a9854c8192\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"2c61307e90862dfd\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"3ae3d88cdb3dd822\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"031a5b5c5dcad48e\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"87aa7457b94d331f\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"bf84a0d26c813b62\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"407c2a2862fc68aa\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"70ae6c53f438722a\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"83914bd4fd8ab892\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"b5c07e6a121d99a1\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"a953751fde4c4ab3\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"b0e5fb04e2737d4b\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"ddf824e08accdf79\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"a00c2fdf038fce15\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"752c662d875b6741\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"ff08830f9ea162ea\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"d71a4921fdb7e797\",\"/knowledge-medium/src/components/ui/button.js\":\"1677db59f9a17f69\",\"/knowledge-medium/src/components/ui/card.js\":\"02bd0bbfa45edf45\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"75ed78b1ae028c91\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"a0f097e1f15401f7\",\"/knowledge-medium/src/components/ui/command.js\":\"cefbc2d7d7511316\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"023ee1a054f56608\",\"/knowledge-medium/src/components/ui/dialog.js\":\"11e683e7a55411e4\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"b22796e79ea25daa\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"8321b066ad85a093\",\"/knowledge-medium/src/components/ui/index.js\":\"2512a5745de68b41\",\"/knowledge-medium/src/components/ui/input.js\":\"5ca36582425b41d3\",\"/knowledge-medium/src/components/ui/kbd.js\":\"304c3867354894b8\",\"/knowledge-medium/src/components/ui/label.js\":\"995bf9bd05cbae1f\",\"/knowledge-medium/src/components/ui/textarea.js\":\"f5dacd399bf2729e\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"53f049ae6af66650\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"d2495b7346342d7a\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"ab37f15a560e114c\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"148cdf233aa43268\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"6a07f617b5c4fb73\",\"/knowledge-medium/src/components/util/error.js\":\"4223390c50372aae\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"dcb5c861702c8b26\",\"/knowledge-medium/src/components/util/suspense.js\":\"8966bb6a35d11595\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"0d579e161df50cac\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"5a5cd086d6feb407\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"f3fdd0723303d38e\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"faeaf8daecb944c8\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"c7c17e73d2dfd363\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"2edcdd0106000c4c\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"44d764dd61df4c87\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"ecf1b90e61b7c819\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"503af2b1dafe707b\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"2f3f812eb7d23bb6\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"7f89b4e5e9e01375\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"cd16607db3e2d87a\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"17e279429cc3ac09\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"83e758b96a1e6995\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"8f5bfc5e5c9ba2fa\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"4e61d81ab54723f1\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"1e0ef7e55b79a208\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"b75741c22b9d7e29\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"19886e50b80e3d97\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"45e6d638a6820690\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"cf524414fdc0134a\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"4d3604aeac1b76c6\",\"/knowledge-medium/src/context/block.js\":\"631c569572e952fc\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"1b6d5f95c456d6eb\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"9e86a4b434129782\",\"/knowledge-medium/src/context/repo.js\":\"15270efe833de5cf\",\"/knowledge-medium/src/data/aliasClaim.js\":\"4c49b98b7dd2f098\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"997c659d25dc22ee\",\"/knowledge-medium/src/data/api/blockData.js\":\"2c5e57d3477eed85\",\"/knowledge-medium/src/data/api/blockType.js\":\"0e9cd4f64a62e909\",\"/knowledge-medium/src/data/api/changeScope.js\":\"86ac64d5434b7e1f\",\"/knowledge-medium/src/data/api/codecs.js\":\"cd6960b1108a9912\",\"/knowledge-medium/src/data/api/derivedData.js\":\"5c95c2e5b5c33df0\",\"/knowledge-medium/src/data/api/errors.js\":\"b2bb68ea32bab30f\",\"/knowledge-medium/src/data/api/events.js\":\"ab82abe12eb2b715\",\"/knowledge-medium/src/data/api/handle.js\":\"581e02e471aa087c\",\"/knowledge-medium/src/data/api/index.js\":\"f59d598f736ae077\",\"/knowledge-medium/src/data/api/mutator.js\":\"8ae3a3910306d802\",\"/knowledge-medium/src/data/api/processor.js\":\"c9b1e1e397e90c66\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"1555fa993e7af200\",\"/knowledge-medium/src/data/api/query.js\":\"ff230ab893973534\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"72c0cc740d9f97b4\",\"/knowledge-medium/src/data/api/schema.js\":\"581e02e471aa087c\",\"/knowledge-medium/src/data/api/tx.js\":\"581e02e471aa087c\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"11f7a454b8aae70b\",\"/knowledge-medium/src/data/api/user.js\":\"279df5dd9d19cd1b\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"f224e22a67eadc20\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"2908ec05455d4a5a\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"9d3bfa6cb2381882\",\"/knowledge-medium/src/data/block.js\":\"7ee04e8f5e777a63\",\"/knowledge-medium/src/data/blockCache.js\":\"102c08339ad5b56f\",\"/knowledge-medium/src/data/blockId.js\":\"32818c287865a9cc\",\"/knowledge-medium/src/data/blockLiveness.js\":\"ebf183156f23e6a1\",\"/knowledge-medium/src/data/blockMerge.js\":\"a83c2f10d8a1e8db\",\"/knowledge-medium/src/data/blockSchema.js\":\"89f19df5e7b62235\",\"/knowledge-medium/src/data/blockTypes.js\":\"a4374ce5543c2c05\",\"/knowledge-medium/src/data/clientContext.js\":\"a6c2be64ed4d4c7c\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"39f2a33fd97ad5e3\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"213da699ddc41302\",\"/knowledge-medium/src/data/derivedIds.js\":\"fb969d583718b725\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"abd4030b7c463236\",\"/knowledge-medium/src/data/facetBridge.js\":\"d5fe7f76adfa4c41\",\"/knowledge-medium/src/data/facets.js\":\"484d00365a7feea5\",\"/knowledge-medium/src/data/globalState.js\":\"2fc66b5fee87854e\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"8d8bfe14ad2b9bea\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"106ac8a374af2138\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"3766d35bc0b4ac8d\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"a5fd2601b23f0fe8\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"4362d2eb2a5a30ed\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"20513f334f63ff2c\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"daffb07ab3ed82d2\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"19d473a9d37ffcac\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"217b06f777e47eb0\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"63dc5dcdc9ae18fd\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"5c90dc2f84ba7f63\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"6273b2ee659b2df6\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"066ddd40f394c6bf\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"f4edd1998c5e95bb\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"1a6edfd3540c6c71\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"d9c69c07d7ef963b\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"2fb6def058f67735\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"f09a491d64b2581f\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"a099885970aa7261\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"b3b7182d3c3908dd\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"1355d901dbc58422\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"ce6817b5cde7911b\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"1e3d90ea8a64f21f\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"9a7990b80c20a431\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"f18378e335d6f953\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"824a0321815bff24\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"4bdea81da76689bf\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"2bd961aa41825b0c\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"fe846e8c8322c4e5\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"169e3ea678566321\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"0d4bf1a7608826ec\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"b7dddb36a132214d\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"709384fd7f1fc07b\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"27e469a9e99b108f\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"a84d1d1cf8ab16c1\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"dd85760a4bc35272\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"9756a5ed4b1fab9d\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"5df8cea86e412adc\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"2a5461a9fbc43ecc\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"040f8c0a8cec70c3\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"1e305ccf103e6d26\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"51298ca732e45ca3\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"44542007c094f984\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"804e57d016464c6c\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"96f555f2bfac7b74\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"4b0c1055115cfff0\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"11e6af7343d61641\",\"/knowledge-medium/src/data/invalidation.js\":\"3d87996a5532a9a8\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"860ea2db74bc8b9b\",\"/knowledge-medium/src/data/kernelPage.js\":\"83823265ace19eb7\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"1f7c8d272ddb97aa\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"1c80e02238683b76\",\"/knowledge-medium/src/data/localDbStorage.js\":\"ba2334589d657fd7\",\"/knowledge-medium/src/data/localDbVfs.js\":\"3a8b4f4b9284706a\",\"/knowledge-medium/src/data/localSchema.js\":\"b54ad79edf897f68\",\"/knowledge-medium/src/data/maintenance.js\":\"ae03ab9d30093114\",\"/knowledge-medium/src/data/mergeProperties.js\":\"199347dfc97d6156\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"b913dd4405ebc3b1\",\"/knowledge-medium/src/data/migrationsPage.js\":\"8d58ee7959ff83fa\",\"/knowledge-medium/src/data/mutators.js\":\"4a78b7c7a9197ee6\",\"/knowledge-medium/src/data/orderKey.js\":\"d1371e9a5b974a88\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"2c7aa0be2f08bfda\",\"/knowledge-medium/src/data/outlineSurface.js\":\"7409142ff98d3540\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"ac09a247b8031b20\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"17c43d1d69e7dc3f\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"a0cd503a6612370c\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"0ace03237d166e84\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"6dcbe0fa7b3b4ab8\",\"/knowledge-medium/src/data/properties.js\":\"42dca930c5107fc5\",\"/knowledge-medium/src/data/propertiesPage.js\":\"2274e98c3ee16f36\",\"/knowledge-medium/src/data/propertyChildren.js\":\"8935caa5f88af0db\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"32b91e7d4cde9e29\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"0f44d20d3b94c899\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"6380cb9752f2ded2\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"27dc4d4cbefbea0a\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"0e46ff6e9bea52a0\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"83780a95f0aa7805\",\"/knowledge-medium/src/data/propertySeeds.js\":\"03d7e51b4c145330\",\"/knowledge-medium/src/data/recentsPage.js\":\"85ea590aad33dd53\",\"/knowledge-medium/src/data/referenceBlock.js\":\"7843a7ba2f721177\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"170f684ac838130f\",\"/knowledge-medium/src/data/repo.js\":\"4a48ce73d1e4fe71\",\"/knowledge-medium/src/data/repoProvider.js\":\"6d113e0a1e3308ca\",\"/knowledge-medium/src/data/rowProperty.js\":\"16a46b21d7e83cb3\",\"/knowledge-medium/src/data/searchFilter.js\":\"862d3fec1d5ba639\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"c77c4c33af90e125\",\"/knowledge-medium/src/data/stateBlocks.js\":\"5f91048c26f8e583\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"e2652ae285081973\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"3a7415ebd02c251b\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"c6a77808413e7ad5\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"74956d9e2bc4015e\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"d2365f828905e73a\",\"/knowledge-medium/src/data/targets.js\":\"cf56176d89c1cecd\",\"/knowledge-medium/src/data/typeColors.js\":\"b5b7d5ac56427e56\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"7a90f97245e8a9d2\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"bc79d18bef14ccac\",\"/knowledge-medium/src/data/typeExtraction.js\":\"f490e22fdb69a47c\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"a278cd8c8b675354\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"725d692cc36eb118\",\"/knowledge-medium/src/data/typeSeeds.js\":\"a271258eb3c24333\",\"/knowledge-medium/src/data/typeTagger.js\":\"34d0b6ef77feba52\",\"/knowledge-medium/src/data/typedRecords.js\":\"84cb4a6a48e791f9\",\"/knowledge-medium/src/data/typesPage.js\":\"49ca0ee70f9bf3e8\",\"/knowledge-medium/src/data/userPrefs.js\":\"c55ac0fde4b75845\",\"/knowledge-medium/src/data/userSchemasService.js\":\"e0f7e644eb5c8af5\",\"/knowledge-medium/src/data/userTypesService.js\":\"a5ee9a5a1ed264d8\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"1da40a793acc1530\",\"/knowledge-medium/src/data/visibleChildren.js\":\"64dab70476c5945b\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"55e4bedc6de37a3e\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"e81d493d2ffc2f7c\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"16a66759bf5e334d\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"1fd4a9d13f1cb351\",\"/knowledge-medium/src/data/workspaces.js\":\"a5bdcb54298a5045\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"a74646c0bebe2d73\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"c3fabb9aebf539b1\",\"/knowledge-medium/src/editor/atTrigger.js\":\"95bd3e888ee74e07\",\"/knowledge-medium/src/editor/autocomplete.js\":\"3b3f0f078d281cea\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"c150b55521b6a5a4\",\"/knowledge-medium/src/editor/contentFlush.js\":\"02b84f399d3e1ada\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"0ddd5e182898b053\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"96acb059be5959c9\",\"/knowledge-medium/src/editor/insertImage.js\":\"124fab1e5a57470d\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"84edd290f8fd01e7\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"cd2dfa23eb7d73fe\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"93b2652239e5df8f\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"ff4f1c4c630e242a\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"0c611762fabf84f8\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"4d3e920027df9afe\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"1930583840e03a5f\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"19f087cf388249db\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"c4c7cae5dd7e927d\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"96e892c1a5e2ac20\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"0c142a177a8f7e9a\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"6c35ea15789a5a8c\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"b3048652f5c5c40c\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"52150810966f6d42\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"c15bb35b74f88cfb\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"5cea0ed93c03b5e7\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"8cbc1ae45407efd3\",\"/knowledge-medium/src/extensions/core.js\":\"de3e50231a408499\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"8adf4b2ede80fb05\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"1ccb4e4da474699b\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"17055c12e161788d\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"b01ae37443d62ef8\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"b31fef3528c032c2\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"a1e7e3b4c18304bd\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"372ecb01b0d5525e\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"55ba2bc5fffcf938\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"3dd7fedf211aa890\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"f42d3d48e999b940\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"0cd880295ef73881\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"559c5ac13a93f1bb\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"ebc2c00420101b6b\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"cf59698d2a2f3d25\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"6402ee8a85493fe1\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"098a2ccd71fb181a\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"59ba99567725a668\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"5dfafb521b36c20b\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"d00944d08371730d\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"cd1a78ca2d67f2e3\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"db0a1507f79d78c7\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"b831bd32a37b14a0\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"a3dcebb26410f3ba\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"b33e23c922602d91\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"b98d8c85130e6517\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"0f4a57bab5f1e2ea\",\"/knowledge-medium/src/facets/facet.js\":\"2c20f2af2a34cc5f\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"36dc61e82997a40e\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"815d64c4918a5402\",\"/knowledge-medium/src/facets/togglable.js\":\"6581e0e3971c86f0\",\"/knowledge-medium/src/facets/variantFacet.js\":\"fc73bf70d23991e6\",\"/knowledge-medium/src/facets/verbFacet.js\":\"a8c10cbd90bd255b\",\"/knowledge-medium/src/hooks/block.js\":\"e512baa8d3e85941\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"1df71b0b130dc3e0\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"42b2aa5ce26df5c1\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"3dca115d480324dc\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"a282b0004454ab27\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"d748fd64eb032a4b\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"31a5e667b6f5d10f\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"c32772f9e75f4b60\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"397a198a83e183b0\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"253ddc56dacc52f7\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"99f9ca19af495e5a\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"b4c87e5223c089bb\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"e07abfb72550cea8\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"301cf3e96f18197b\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"e8ef61b4daee68d3\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"5bfc7d85a14cb642\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"6dfce5ca21c9c974\",\"/knowledge-medium/src/lib/utils.js\":\"d032cf11e5ce85f9\",\"/knowledge-medium/src/main.js\":\"45f45c820cf1871c\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"989ffa91b58d003e\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"6b13d000f46bed24\",\"/knowledge-medium/src/markdown/context.js\":\"96c92d9e7610dbd2\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"a55b1b4029e1bb5c\",\"/knowledge-medium/src/markdown/extensions.js\":\"79c594fe4a5d4684\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"5e9c7abfff5906a4\",\"/knowledge-medium/src/minimal-editor.js\":\"ae647ae02da329b8\",\"/knowledge-medium/src/paste/armedCut.js\":\"e9bdeba3888973f4\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"f4f1fd1bd62f4ea8\",\"/knowledge-medium/src/paste/clipboard.js\":\"cb2ad2f7b7760ae7\",\"/knowledge-medium/src/paste/decision.js\":\"1fb3d9c97540b43b\",\"/knowledge-medium/src/paste/operations.js\":\"823c3eeb96eb1881\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"4a45ffcf952aed55\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"2b1d2050a053b183\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"31069e2c9b336aa1\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"7a741af59096c420\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"e80838466b803598\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"7d8e462a08e2dc34\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"218a6770587913d0\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"9ee17ef771a78f8e\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"86e2a3f30bfb0407\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"8660fcb544937266\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"4bb0f6fe4a5f9e3f\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"d6cd915fdd2801f1\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"fe4de5e3fe4e161f\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"c7cd48c9351e9a85\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"7a40343fb2e92559\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"b926b69ccbf14a5a\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"1fcbc918a294e989\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"1f57bae755a88530\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"b375f280142756ae\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"05fb5ae4002755a0\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"8393532f2afdf747\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"1322edb987060818\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"0742586ac9021bbb\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"d9ebe3661c21fd77\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"8c19f56106150703\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"8658c1b0384f0d14\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"c8f28a774f8a8cc4\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"d8c57df6cca0c203\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"ca3cf84adeb1003f\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"5a35e39e32689885\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"e492adcc6bbc0185\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"1109b81a28354cf3\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"42c9dc3e27b28757\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"b23b61f3ef5e1a2b\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"56d89ddcef94ab70\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"413da87bf67d66de\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"347891c9504a5019\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"74f1772a785f0bcb\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"28666eb0ae29d46b\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"40b91499c33373ef\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"c636fd9b9aa23970\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"1fb24e14026f8046\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"bcad05be7c7655c1\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"29395de31431a715\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"62c3a5321ef76e75\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"d4be1c5ba5c12d5f\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"12b8b623829c07cc\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"57ffa5a7a0799c9a\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"05dd5dc79a4fcb71\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"757fef1823a43bb6\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"7eee8e33c995f95c\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"b719bba71a67eff1\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"ba95ef887f8abcd5\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"48b2a803d22dea24\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"c62da90631eb4251\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"6f8f6602bb98d42a\",\"/knowledge-medium/src/plugins/alias/index.js\":\"797253440c8d40d0\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"9335832e8b79224b\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"a5a75e76219f1457\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"2ce1c7099a38d997\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"577bad8e5d8a485e\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"82ef7bd54f0e85cd\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"ccee555c37218a6a\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"952217edd0027202\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"6fe108e687c55221\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"7c99d126236a46a4\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"3b4fe86f78b2a603\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"8d33a43cbff0f369\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"42623385c431470d\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"c19869ea813f4a75\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"2809bf801d13c54f\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"7fb07823d863c94f\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"2e5992c660215e9b\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"b4f100f915eaf45d\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"b511a8bbe7d4b2d9\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"789c880333bdb7ac\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"c9d46677e7ffc78f\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"e30a346d894c5280\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"eed1de2814abc24b\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"08275fd707c83480\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"e965e2ccfd864083\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"f70fa6eaaf3c282a\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"92f4ad03c82a42fc\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"5bbd81e22155ffb3\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"9959084355eae848\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"a27e7951760bb295\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"1aa17b49977ea5b9\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"8b82094c5a506d06\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"4635a7ad19208aa4\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"54ddf306f936a5c1\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"76b5710126cee1f5\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"bb7aff6821893a74\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"13a560af0937c15f\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"f4f58ff62e880d3f\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"6b65c183c2628eec\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"6c69ff88743a1a23\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"e5e454089d9221bc\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"b1fbebe0cc587bac\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"cbe7b5e0f9206418\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"5a43e41c97ef7045\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"bfeb7e528cc79e3d\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"44753ce939af468a\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"b179a3a06a5c4f96\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"f89d8a09e7f1aa11\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"ce3579fdff8b1c23\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"85c5d84cb7e27e16\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"8b9ec8b13995f425\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"17495a901467d939\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"bce98a2f0f3bd898\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"ae4cb4818f146d31\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"1ff6f65b0594aa5c\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"de3d711396bea4ed\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"24d91cc4a248a6f0\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"8a9f2bd3cb8b1afe\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"27d59f25a031279d\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"34d5a3eb6476d432\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"67cf46062ea060e8\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"8efa1e0bc93c73b1\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"9b575d3a55878caa\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"edbe0b344b8be5da\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"36ead57e90cdb683\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"d6db4a66c8d012a6\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"dd5471683d4fbe43\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"a7cc59270aadaf55\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"5013101cce29d2b5\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"e350ac7015934310\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"f5f0e5b81262d634\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"df7559f0134b9da7\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"bbb70d62db069ad5\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"cb2cd3ecd602ec72\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"5d3ad2bf90cca135\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"d73f56e3f3e95f00\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"755b70d5201489d2\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"5b9c6dca8f3015f1\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"1c9d94cf439129b1\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"1dd62fcf60e786e1\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"6e7f79e1b1021f98\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"0991a16d6b356a33\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"f4d808c2de4005e6\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"9754d6e0e314f8e9\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"579743db51b7edfc\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"8a0a6225361061b3\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"3a8e78c304e92782\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"f4b8cb3d791e6d7e\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"79dcaf5809ba3311\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"a53a808f91b4d869\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"ccc82002b8becd8d\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"609f40b9068dba33\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"8616455a33f87693\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"df9868b1bbfc32b6\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"7ab2dc948bc4b725\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"c70ea5e8503c0554\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"23e66c1afc2e23e5\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"de97c9407347246a\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"a2ffd1c37e068167\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"b865eaa661257b8e\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"a0dddc649f28c4fd\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"df7dd2df52147037\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"26ec20c06d3215a6\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"312a03e5308ff879\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"3fb39517f8f17a57\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"f37c510d2c73a2cd\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"790f14abc2e9ce00\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"5a2d2a1aea7e4296\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"e71ca8f8f1f2c936\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"61869ec06899dd31\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"8653c6b16a835024\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"8fbb59d26508259d\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"89d18ab6a19878bd\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"c87021c4ce41e263\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"88fa92b5e09c9cd3\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"ad608af5cee8a1b5\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"9c72fa01027e2fde\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"6d3d25535584bda1\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"cb9845ed4b48de47\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"0ce251c3d67987d4\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"9c72cc48cf74e351\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"1e31504435d3adff\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"26a5b3e341e988f5\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"433f6b451c61fd4f\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"4f39c5a82985fa8e\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"c98fb2b1769903c6\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"2435b8d978f7cc8f\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"1cefbb7866c4aa34\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"07ee8322ee18050f\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"93e82d1a21e551f7\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"75cca8c3edcfdb09\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"b2d4cb945af6e66a\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"dc422c0131c548f8\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"b0e083005127576c\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"28f9309707053403\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"cab61486af5cd3cc\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"e8ba865248a993fa\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"192ba5c583e60469\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"fa103e7713e86953\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"8a266e0c9adab999\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"bbc927188c0823c6\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"0cb864df33c1373d\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"0e8d25672cca3ecc\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"dd4328a6c96249c3\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"ccc7de88ef68e6be\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"81d664f40d5313af\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"3f393d9d854d8d8e\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"934588805e55f95d\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"71e61faf539d4fda\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"095ed32c9e649e6f\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"ebb28253d11ff7dc\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"68a34208a642176b\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"ca1273c13b297ebd\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"302aaa270b1bd8eb\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"aa0d7b240abbb1fa\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"8e86a4ecb9b569ad\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"6425cb97ba95d0d2\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"362acf68645554c1\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"53ca4c745db24c5c\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"a5aa38042d708228\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"3207edbecf9942be\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"2215ce48ac61c3dd\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"16b08026f69d12ff\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"76fe2dbb2d74033c\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"2ece1195cb6914c3\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"d6eb25f24b9e138a\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"8ba6f7113ae6066c\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"ae3784a4b80790c4\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"7615ac28fb97f97b\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"f2e504be3759d53a\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"4d584d0f989cc3c7\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"22803f505c56972e\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"22b0edda04a70245\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"a2ace4374c89f9a1\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"ce65553f43534d94\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"3edb635e049ced54\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"9a0b1a90be2d76e1\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"8355f72c8f6f362e\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"2fc4764bdcf93821\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"60fdb9fef8ee99fe\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"4886f6f01084c724\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"08a64c1a515dea2f\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"5e1845b2156fedc2\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"956ae55efe7f0cd7\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"5f9f1e4e79d79376\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"d8dc567a983e5f0f\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"9a32f932958ce18d\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"fea3543507fe8d7a\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"d9747e4645834da2\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"98abef6507553c58\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"f11cc0e4169d3a8b\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"e40ba3ea1f7d94ce\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"977f1716392785f1\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"d4662b3a30700b8f\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"ed7c0d90c27a62a4\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"2b1859bfad648ce4\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"3666f50cf8a93c1d\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"454db512e805ff5f\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"db82501fd761a64a\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"12c9ac0d65cca98b\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"8196173bccb82b4a\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"c7c72a7188fc286a\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"118674902b0c0c51\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"efeb152c19759d32\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"9cbc0566dd18b067\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"64a61fde5d9f276f\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"ffa1c2bc78296d3f\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"55d61ca35d4cde48\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"7a743c5369875544\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"1b30708a390f6abe\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"75cd64965f088d69\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"50e560eaba8085d2\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"cf8904066b2620c5\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"a4cbcbad4afdcbdd\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"5c0c9db13f345ffa\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"d01f9a7b5f3ad1e2\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"f432e51df9d201ee\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"c16cdb8deaa41458\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"75408044e9ae4a0c\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"d173cead974fbf81\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"6c50462841761ff8\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"4ffde8b594465734\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"a83a199f858cd7cc\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"9f7ba4989382dace\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"cbe3e5cf4ea64ebc\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"24e5ef8950fee5aa\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"de0147f9ec36c9d9\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"c0e1a553d5bfe2aa\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"9b08ef25efc1e28f\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"6ff9b00ba119e738\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"3c2b4434b4b6e1b9\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"e8042cdfea4900aa\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"29e373670c0ae1f3\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"44e963361a457db8\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"a1c98574ff8cbd5c\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"d9d4cc24a9be092f\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"7e66d40a2636de52\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"78a2df9e9c4520f5\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"eece3a5874433f3f\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"12020aeb5bd538a3\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"4943db0ccbe7f2c5\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"f2dfe9df94c069cc\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"f2b4358039459663\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"49dc0bf01ccffd30\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"21332eb0b3e1c6a9\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"161271c26c0b5c8d\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"aa07ac584937a0c0\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"3f182167267c29ad\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"163a9c4e89af718f\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"b3c9df94a92d5f4a\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"597112825247c885\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"eaccaef751bf97fc\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"17c70891c91e49c3\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"22397bedcd035d9b\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"ec3a1c32477c7745\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"fe235364fe236dd2\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"4c64e6a2af3ad554\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"3eeec931051e52ae\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"00f5cbf4dc4bf1d4\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"e951b36016f91ded\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"cade5967257293f3\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"8766d375eaeadbd9\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"73441b2575aa9636\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"f0d8c3509b710f32\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"1eda6ab799d7819f\",\"/knowledge-medium/src/plugins/geo/index.js\":\"8afaf9e6efb85237\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"fdaece1a0a42a9d5\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"3b6a2c240ad65ed1\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"df11ff1349339f7f\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"c2e204810c29081c\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"986fd63bf02d0f24\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"83bb92dda2d74303\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"7ee261e7581743f1\",\"/knowledge-medium/src/plugins/geo/query.js\":\"b061761dee90ed08\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"34491502f98273b1\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"7f8c3e2862b4f290\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"e6cf9ef909cbcd45\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"354e5d11e5cf2a8c\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"84cfdd7c33a5a1b5\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"8f0715c87ced78ee\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"ef64e8e87cfd2327\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"91c1548615900f61\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"df7498f54d5995f4\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"753b5579c67f8ca0\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"8a6b9f30f48e6537\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"8a3661e87e53544a\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"d1bee5164e9f6862\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"3f77286b3ef8a9e6\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"570017571358c6c7\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"b7911f420d7c47b0\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"d7d9c956e4397e08\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"f9c2c4a8a8e80437\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"ab6eb0a0467783d9\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"8878c7c5534f4aa6\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"758994da1e92a5d8\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"0ecd42b4faa0ebff\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"02261344e8ab7ee0\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"df9dbe012777ecdf\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"a1e8fd292c88d511\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"5717433e8f370d35\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"e473d2659a5314f1\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"d195d3de952fb3d0\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"f40c32b94b6340b9\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"ed1bff036c55491f\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"175eb35a9243f18a\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"8572ce4adc9e3f2d\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"17822bcdbb2c687a\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"cb42a94367de6e4d\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"536ef344dfb7dd8a\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"a07a90efa71ea44c\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"7ee6867e7de83304\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"ef30b1a17c1d3bf6\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"00d8d667fa11b076\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"5a96185abb35123b\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"349cb168748a744e\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"bedddb7f76d9243f\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"7c83d3a17a5011ab\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"764cc64ad69c2e14\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"1bd1d824830be9a2\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"a8d0a0c93aa44d06\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"c73933c8646537e4\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"46bfd668921f2041\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"04c18f579f968c5a\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"a4db9ee43a1da6a9\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"3cc84a36e0a913a3\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"002aef76b5a92d3c\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"4f74186292a5347b\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"c12da000820ff4ec\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"0c352e0d53439478\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"41cd7004191593b1\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"ccaee6dddc6dd457\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"09339176b8c9a32c\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"a199af67f14b64e8\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"1cc4923f68ed5459\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"c35a02ac6e7de27f\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"ffca50cd11efd8e8\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"20a685825a226f20\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"35e6ae9bec99a090\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"6478e846ad98c2ce\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"7d6e16a8451973cb\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"3d84da3800fde3e1\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"a0fa3c0a0ab7c118\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"2f5a5eab71ca9eb5\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"008523f9acaac3fd\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"22d391d3a05c65e1\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"a693d2e0fee41b3e\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"5d9177f5b1a3b601\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"e9816163eab5483d\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"be6d1d233317ab4f\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"5c0ce1621b25c7ff\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"1b774c9d2a7d5805\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"60d967dc8f8c9e8e\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"8eab6fd9c8f7b8b1\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"ed0c166b7fb7e7c1\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"06baf53624735041\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"404c2dd20c7373d7\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"6c38384f0de555db\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"cef31cd98bb849dc\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"7d2df36e8080b3c7\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"d2013a6fa2bad46e\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"1daac064a8e8644a\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"e7fef0c38ed83923\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"e431b8a4f0b7c869\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"faaaac11f8b74bab\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"872a3fc20a7bd9a6\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"e44a2d6173b3e968\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"305e71c9c560dfe5\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"0f5ff99d3cb4176a\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"89c31d75dd726941\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"17ba790b942af2e8\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"648b94ccad7caa7a\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"15e68cd3cf2867b1\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"00cff2f08f370884\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"7b411146c966161d\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"e8f5218025d64d8d\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"14d1a6218840f478\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"eb0f7c3e97d16d45\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"fa3cd09d495d8d21\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"2cd0454d60772715\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"c8b240c794edea25\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"6d559bce9b67b27a\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"f05858a011a20bb2\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"5fd308d27e747226\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"4502bd58745ce86a\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"7bb907c27910316f\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"8ee290cfe654bf81\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"8fec4d4d4a20afb1\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"87befad45c7f2941\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"bff854bb05838a66\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"c4ef82fcdb712c53\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"8e2434d9cce5d487\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"341fe79be8b0b587\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"79cb64e7315ef26e\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"199c3d2db3771a98\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"49364cb8ddc0b5c2\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"153a30aedd485de5\",\"/knowledge-medium/src/plugins/recents/index.js\":\"cdb29c39e602f5e5\",\"/knowledge-medium/src/plugins/recents/target.js\":\"f79b53937ae32ec7\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"4308d25331eff229\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"54f974b18dec1318\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"f0c28c33c1a5ec53\",\"/knowledge-medium/src/plugins/references/index.js\":\"6da6e260cdb9dabf\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"b9e37ef6d6abf4fc\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"685c3781332f54aa\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"049628acdb5b5c60\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"7ce481398ca9daa5\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"9103fa8b34fef9bd\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"21efe170c6975c60\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"6d3551f6e3214b56\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"411ff051e58223b0\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"06a556e7e6bbf941\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"31290a15878aff1c\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"cc8647bb0faae420\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"11441aa4811705ad\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"8d4e0bdb7549415f\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"42edd74282529dfa\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"a06c2f72d00199a0\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"f00b235b7baf0e29\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"de712a3061ebcf51\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"87ec8b7d32fd33f0\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"a80feeaaa5ca9775\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"461e8ccc3ba9e41b\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"4e9a4b0e7581751c\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"050162f347c9ecbb\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"4e61e1c9a22097eb\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"a1fe97dc9771445c\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"413d571ac59f43f4\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"41484c2a224c194b\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"3b711a4e316bc9ec\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"5e2be23f4dcc00b9\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"549fc85b01d7e02d\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"7d57c70d1b34e9a4\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"f84b3090b21edc82\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"a2941b98fd26ae2b\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"2af28c623f9b70ce\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"b86e1ba96a646d14\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"90c0fcbc4df4bf67\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"a505e7c48c2f3311\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"3bee924744a3c0f6\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"108ea8e61afce066\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"52d5fc68378289fc\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"5b1e9f55afeb9772\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"635b325ab2c61179\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"225af1a8955d47c3\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"017e9fedf381dac5\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"a83552010eac7757\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"d5ba2ab218508abd\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"326d7777ee15c572\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"835966936475d9d1\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"90d08de447fb4416\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"2c3daca243c97e60\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"ffb034a9a2f0d731\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"14c597790348aee6\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"a269f9385aa44311\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"7da903234c27f2b8\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"aa4c1f79997dbb65\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"3fd3315aaeecc8cc\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"f3119b635d3b6348\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"37cb538fb0be79a0\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"7600644f4b5f61ac\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"0797faa66dfdefff\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"b304f24d2c790cc4\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"d23f3d011bbe961a\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"2f61a4a9d84da531\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"9c088cf32b043313\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"69a90c2ce762e7fd\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"11c6fe11ac865910\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"e40df46189817147\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"281442b97fc17793\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"cea4c0de547d7e2c\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"8d270485a43a485f\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"c13642fd43363a82\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"4ce5999a5ae7a00f\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"bcc712b5bece4c39\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"88e3cbdf9b039274\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"4535d97b18275839\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"c6c7d855a4d1971a\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"0a27152700159347\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"4b8162b88b572eff\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"8e489a856c19e162\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"1b0140fd95f19b8c\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"2661970833d3af49\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"0d22cec9731469bc\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"1de0c10096ef3080\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"deb9195938c0ffc6\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"044f141936963aba\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"16e182f399c85336\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"a6862b7ae743ba7d\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"b589eecd8885e202\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"50a694aeb2795053\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"37cbd15e0986b7ff\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"763f9a32e2e9987f\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"2954a95409eafe66\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"e375f2d254f54069\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"85126d3ba5cce7ea\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"66700ce9bd96992f\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"9aae466f5de6e2c2\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"e29a137535d4ec07\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"6d6b57f6590cdda2\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"bfd78dc225844cb6\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"8cf35b4fdd33cd7e\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"2cfebcb2b843195d\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"eb764ecfb1cf33b3\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"b452f28d54da454a\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"7b523d1346d558e4\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"90a627e8f965d9e8\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"f0479aa0973cfeef\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"fe6cfdfb2734715f\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"4f8e9af74190efcd\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"c7389bdfd0d00798\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"976ecd6de0ca3715\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"957e1b1f4f9993e1\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"7e90e28cfe0f528d\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"95f600ed304961b0\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"7bc018e6f5f391bf\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"43ed9866e76cc7d3\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"c4350a72a7209b1a\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"7df871f316c569c0\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"8936a916dea04bcb\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"34d1493da0f6332e\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"fc605b6265eb14a3\",\"/knowledge-medium/src/plugins/todo/index.js\":\"2c869175050983a2\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"85c572e224f0fa40\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"5c172f1550dd3282\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"3f9620ab20f17c7b\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"475c6524cef2efcd\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"fa60b23c7e77d266\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"c7fd2c9b94eba337\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"c2463c0499f82705\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"c78a65a595a6aac0\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"28218faad581e7da\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"104fc7143f8809c1\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"2b4c0736a63f859c\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"d0ebe39416656d49\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"def1d073a3481189\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"d893a5b9d875329d\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"303771b2edbe5fd6\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"33aec25b1e949820\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"cbafac5ec0ba6e66\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"392e98b41374ba11\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"e4c0bc6be54705dc\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"b63db459288807a9\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"97c3b5a0eec1e285\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"285aacecd6d1e03e\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"25e7c6ba4bad2e9d\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"9453a88fe658f19b\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"282a5b64ee74ecb1\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"1ffe5b1f59ca9e8d\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"e9f28945dd9b8b5e\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"2eb9e2922b85fde9\",\"/knowledge-medium/src/registerServiceWorker.js\":\"9b5066388d0af4e1\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"2c15ba09f807e18e\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"9197db9cb46db64f\",\"/knowledge-medium/src/services/authStorage.js\":\"f152c1293acde867\",\"/knowledge-medium/src/services/powersync.js\":\"cfd1c0103024591c\",\"/knowledge-medium/src/services/supabase.js\":\"c8868c4968efdaa0\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"01afa92d81a91c9b\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"7dcdb9fbdfdf27d2\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"e4cb53ec012f46da\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"e857246570dce42a\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"8910b0a62c759610\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"53f5179e20030caa\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"670bfeeeac88af6b\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"3143afab8f1089f5\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"96ab9410fdf60490\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"7a9511aaf39e5390\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"fa434e0aaf4ae97f\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"4aa3f329cea6a8da\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"c0720bedb69fcaf2\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"abbfe70abbbff280\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"e73ef4b8da235d6c\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"4e467d2b29c6601e\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"428af3f7bd924fe4\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"434312fd4174d862\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"e66519dea7bdd482\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"92f3895d0fdf98c0\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"26fc884d40ebd9ef\",\"/knowledge-medium/src/shortcuts/types.js\":\"bd4588822bee6c7f\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"660322100887ce45\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"d5b827fb097c70f9\",\"/knowledge-medium/src/shortcuts/utils.js\":\"df6b23417d851c1d\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"3ca59ef5b940b74b\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"16da3e91d6f0f94a\",\"/knowledge-medium/src/sync/byteTransform.js\":\"4377087a9083629d\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"63cbe29b26a4f723\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"34e0277678a3e53a\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"afa7fdbe311c688d\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"e3e11e45f0f8fb18\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"51907e6ae2f9dbdd\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"f367d8d47dff8344\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"5ed63868ae96f14c\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"739ef625eeb86320\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"529b9840cfba5c3d\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"d85c967e38bd14c1\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"b267d7f9b985b265\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"af42ee406161ddbf\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"61b7397dfacc8f0a\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"246282c7760f8c63\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"79c9a33519a16ca5\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"4ff76e2d80168dc8\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"156418c766c3d2e5\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"ae1058933817a102\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"916f3a65cc266a85\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"db656007e3c1f0d4\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"0ed7133c92d13017\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"034a34f3236076fd\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"3caf5214aaf63e6a\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"830a7d60b0b5c1d0\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"255f1ab2fbfc5aed\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"b17adffa6b944140\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"36a6d1f450dc72bc\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"83b28d29f1d9d953\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"fe8a2877b1da7cdb\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"c7c8384aae6b728d\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"596a8a4ed7d2ffcf\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"21715134d25d12d7\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"5453f90a4d28675b\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"90f0ec23e3a69fb5\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"02790cb4ac38845a\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"4624fbf6a72649e4\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"a398b302de9cee90\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"a2be8d089bb6554c\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"1b168b445d2d7858\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"57baf0c46526f784\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"18a7350fca80c543\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"7916cf56fbeb50c2\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"41ecc4a4e30c29b9\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"5e6ea396746e2775\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"f51f867e5d4d1e94\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"4e842883a0eca1c2\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"3f26581046b38db9\",\"/knowledge-medium/src/sync/transform.js\":\"74c41e8719fbfcfd\",\"/knowledge-medium/src/themeBootDefaults.js\":\"d55c2e9f79f72a2d\",\"/knowledge-medium/src/types.js\":\"42d2268caddcff27\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"b24b5330b2f5574a\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"ccdb770da0bb3e4d\",\"/knowledge-medium/src/utils/array.js\":\"b3ecd18a2d81e0e5\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"a2ce67d07ab6d800\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"901b5e72f04a281c\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"001c97bb9081fe21\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"e7bfb8f242ef8ab9\",\"/knowledge-medium/src/utils/callbackSet.js\":\"0458fbc4c70eb0ac\",\"/knowledge-medium/src/utils/clientId.js\":\"9b72f16259f87371\",\"/knowledge-medium/src/utils/codemirror.js\":\"19d81ceba992f420\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"24ef1cb2d706232e\",\"/knowledge-medium/src/utils/copy.js\":\"5aa61685da428538\",\"/knowledge-medium/src/utils/dailyPage.js\":\"aeafb6c0154a71e8\",\"/knowledge-medium/src/utils/dbForensics.js\":\"24eba96b649ee281\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"b557e9ab63e60f2f\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"e1a158590942a589\",\"/knowledge-medium/src/utils/dialogs.js\":\"75b5f807cd499589\",\"/knowledge-medium/src/utils/dom.js\":\"a439ef2d1d3ef6f2\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"320b5b66be666063\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"68f417307ef79c21\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"518896c13fd434b2\",\"/knowledge-medium/src/utils/flipSlide.js\":\"b8e78f988c402fc2\",\"/knowledge-medium/src/utils/fnv1a.js\":\"cc513cdbeb0a1d80\",\"/knowledge-medium/src/utils/formatBytes.js\":\"c24302f4abbdb7f9\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"5d1d587764fde475\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"e37bfe707374d04b\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"d5c2f9fbf5c161ab\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"c8d174705d1899b0\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"f55f5e99befd83f8\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"f074d7481e90bd2a\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"01910842d9af2357\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"a8a9eb6dfedaa7d3\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"5dbcdca33cd4f3a9\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"9660aeeef65dce6c\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"d789881f74020c3a\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"5cf7cdba29c4eec1\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"2e21c6a4c7f5aabd\",\"/knowledge-medium/src/utils/markdownParser.js\":\"15d7183086c247a7\",\"/knowledge-medium/src/utils/memoize.js\":\"4585f590b31a0d8f\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"94c4f876df38e97f\",\"/knowledge-medium/src/utils/nameList.js\":\"1a16916f6945be93\",\"/knowledge-medium/src/utils/navigation.js\":\"35ead22d14610091\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"10deb8d55c1c01c3\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"60d80864f804ad93\",\"/knowledge-medium/src/utils/panelClearance.js\":\"fdd6474f9d486e08\",\"/knowledge-medium/src/utils/panelHistory.js\":\"818ad0be05b02349\",\"/knowledge-medium/src/utils/panelLanes.js\":\"4971f8379e9aee9f\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"a14a79448d355a72\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"768377c91701febf\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"08eae4bacf3b0e9f\",\"/knowledge-medium/src/utils/platform.js\":\"47dbf5df02b41b51\",\"/knowledge-medium/src/utils/pluralize.js\":\"de5faeb0c674622f\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"97b5818dc32c35fd\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"eec5feb3c5932eea\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"81510f5d838e437e\",\"/knowledge-medium/src/utils/react.js\":\"a707fc858a46c477\",\"/knowledge-medium/src/utils/relativeDate.js\":\"e913d634f3a16472\",\"/knowledge-medium/src/utils/relativeTime.js\":\"b2ea7a5095c82fca\",\"/knowledge-medium/src/utils/renderScope.js\":\"f56bf2e7ab636f4e\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"bada91d3fd26d3ac\",\"/knowledge-medium/src/utils/routing.js\":\"2929bf47c439cca3\",\"/knowledge-medium/src/utils/safeMode.js\":\"391c6b5dd527b95a\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"059d13f38624ed62\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"726ea6d0940b66d2\",\"/knowledge-medium/src/utils/selection.js\":\"bf1f77616dc9f5f9\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"6f39b59cf51b2efa\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"6f2bc82c69848f84\",\"/knowledge-medium/src/utils/state.js\":\"cc5cfd2426d2d83b\",\"/knowledge-medium/src/utils/string.js\":\"02ae75577ae99a9e\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"0dc2de23714db41b\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"c66eeef9537e1af6\",\"/knowledge-medium/src/utils/toast.js\":\"d9b95a4a8ea1423d\",\"/knowledge-medium/src/utils/toggleStore.js\":\"4f89fe1ac2c8703b\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"e0f3c01722bc85c7\",\"/knowledge-medium/src/utils/userActivity.js\":\"cf08a7cb8b5f7938\",\"/knowledge-medium/src/utils/viewTransition.js\":\"415895ea1935b378\",\"/knowledge-medium/src/utils/viewport.js\":\"9592879825e08115\",\"/knowledge-medium/src/utils/webLock.js\":\"a8eb4f7a14a9ff5e\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"97e5fde38989facd\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"3496919eabf52b06\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"168e936cc2fea904\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"82014724e2f0dd11\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"541f943003633d17\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"d6ef33af84550568\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"a582ce814cc44480\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"f33567d45f8dc841\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"89af3147a0b52cec\",\"/knowledge-medium/src/vendor/react-dom.js\":\"2e2cc1aa8281b6f9\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"a3775e4addb790ab\",\"/knowledge-medium/src/vendor/react.js\":\"b5d991f7d02c1f57\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
