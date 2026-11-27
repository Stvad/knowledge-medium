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
		buildId: "b4eb56f87b71-2449da26",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"097958d256e726e1\",\"/knowledge-medium/index.html\":\"097958d256e726e1\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-CSzj1GG6.js\":\"88dcb05641e47290\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"351f83412d5f5281\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-DWzCM7ff.js\":\"5cffcc82870b7e30\",\"/knowledge-medium/chunks/FacadeVFS-DlsiTnIs.js\":\"7fa48b2cc3fed764\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-DAtorNpu.js\":\"271f1c4efbdd5dde\",\"/knowledge-medium/chunks/MemoryVFS-CA9Bpmk4.js\":\"b6becb2d816a18f8\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-D5tvm5BU.js\":\"f63f65d3b48bbe9b\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-BuLLCEsh.js\":\"42823f691f9e0536\",\"/knowledge-medium/chunks/Preview-B_j8g0JO.js\":\"c8c41db0e0d51572\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-CeO_Do4z.js\":\"9119290c75594e31\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BFE59hXe.js\":\"cc40519bd517d9f3\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-BynYLUPh.js\":\"e9b63ba39b568e66\",\"/knowledge-medium/chunks/react-CmwHSl3O.js\":\"3f666e4800b6d854\",\"/knowledge-medium/chunks/react-CxrAwgOv.js\":\"45ae097399ba0fd0\",\"/knowledge-medium/chunks/react-Di02tyx1.js\":\"f488e9fd93f93821\",\"/knowledge-medium/chunks/react-DmnNu_lK.js\":\"5488b544fd78a81c\",\"/knowledge-medium/chunks/react-DuVX7buG.js\":\"ab31dd350f3394be\",\"/knowledge-medium/chunks/react-_knNImEV.js\":\"295abfd8fea39295\",\"/knowledge-medium/chunks/react-atXScllN.js\":\"0e3bb8caa206cbc6\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-Dc8auc4G.js\":\"aa21f10f857634b5\",\"/knowledge-medium/chunks/react-dom-server.browser.production-DhUWBhbW.js\":\"2aa2e7f67268a1ce\",\"/knowledge-medium/chunks/react-dom-server.edge.production-fvbIhsn_.js\":\"285d404e31e1d016\",\"/knowledge-medium/chunks/server.browser-8xwUDtXn.js\":\"20dc6119df9f6905\",\"/knowledge-medium/chunks/textarea-Ck-F0aKb.js\":\"6c15aae81fe87daf\",\"/knowledge-medium/chunks/ui-Dy_S5DTP.js\":\"0a31febc1b9528f6\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"2b78f211b4100e15\",\"/knowledge-medium/src/appUpdate.js\":\"fb7864b6322a6f1f\",\"/knowledge-medium/src/appVersion.js\":\"59ba049645dc1e00\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"3f2eff2e54206ae6\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"de322496b641dd55\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"8f9eaed0140fad16\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"9c184a36bd48e70d\",\"/knowledge-medium/src/components/BlockComponent.js\":\"41ddf829b6b12a13\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"20e0cc934aa2e284\",\"/knowledge-medium/src/components/BlockEditor.js\":\"044ac984a8b20ec3\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"681c50e6b4404cfd\",\"/knowledge-medium/src/components/BlockProperties.js\":\"8e36940221e799bc\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"76abc3916278d527\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"ed0218da786be36b\",\"/knowledge-medium/src/components/DividerHandle.js\":\"c561bf46331b4fc3\",\"/knowledge-medium/src/components/DraftEditor.js\":\"69f57b2278f39568\",\"/knowledge-medium/src/components/GutterPill.js\":\"3caec500f98d17e9\",\"/knowledge-medium/src/components/Header.js\":\"f598a81675105656\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"3ca5389dfa2c3ef1\",\"/knowledge-medium/src/components/Login.js\":\"9549286dfe87017f\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"c66b32f65007ce7d\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"b910933af77bbd00\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"e10f79b5005ec1aa\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"84acbc1bbba56140\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"52c453dd96495192\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"3bff65cf12b3685b\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"d4acfbc9c8e30ad9\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"9db9ba04603e31ab\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"db62b04f17b235bb\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"af16a66c3cf09484\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"064effa361117fd9\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"4dc9a5c82e3d2927\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"32a0095a7ca50db9\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"3db0a296314c6d0f\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"f8ad7da0256125d0\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"a22cc29f7179bd72\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"6135dea8d2d24fc4\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"85f7f4a3f2226f53\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"a6187179cd8504a9\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"c37bb4c368ef5892\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"b4a4ad2ebc32e295\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"3a2297a774d2863d\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"56c13904d49fc9ca\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"edc062b99971e4e8\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"c19acbd50b29a9f8\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"643e8f56c7573cc0\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"67e573354970fbc3\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"a9688e8f08e6f15f\",\"/knowledge-medium/src/components/references/CompactReferenceLink.js\":\"f802ac7e60586d5a\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"122a9832d73f10d7\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"a4a91d2f5cc7d755\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"f9697ee64078fba8\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"6b48802c314609ce\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"a9b79a07a073344c\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"cd0d79764c8ce8ba\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"e47e589efc43af83\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"89150667446be173\",\"/knowledge-medium/src/components/renderer/BlockReadText.js\":\"8177894f304fd815\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"b97a9648334b874d\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"01cd9f55068687ac\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"844cb934c6fbd600\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"ebd9db57d773b74e\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"67985cfdab0d2fde\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"98f84d9a1e3744ba\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"c463c4f0ccb5a7c0\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"8cff340be8d07fcb\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"4157ce0a93cc581d\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"d2d8ce2d2614ecfd\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"3797fa3a02921e3a\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"71b527a361cf2dec\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"6bf955e2d59346ff\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"e86c8e970de724b2\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"f7c0f71d1e105eb5\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"d6016c17da01a481\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"4e4ff5f062bad5d5\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"fedeb0bd3a092fe4\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"65b7a5b0b66a309a\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"68be812c736857ad\",\"/knowledge-medium/src/components/ui/button.js\":\"1c2924c0e6e9a5cc\",\"/knowledge-medium/src/components/ui/card.js\":\"b937c77879c09dfd\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"ac8a8f715c2ca055\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"064c08bfc8b5cf4b\",\"/knowledge-medium/src/components/ui/command.js\":\"57a3f2945ba1e26c\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"b6ca0546d11dfcf7\",\"/knowledge-medium/src/components/ui/dialog.js\":\"54df2cf254d45f3e\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"11bf21c2efef7ea8\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"60d104804fecabe0\",\"/knowledge-medium/src/components/ui/index.js\":\"a2e2243aacb04c99\",\"/knowledge-medium/src/components/ui/input.js\":\"80871b84fb927f33\",\"/knowledge-medium/src/components/ui/kbd.js\":\"0a103c49d9aec875\",\"/knowledge-medium/src/components/ui/label.js\":\"d71847027933bd56\",\"/knowledge-medium/src/components/ui/textarea.js\":\"bfed6c6dce1d7fb1\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"fe9429aacc0d7686\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"81de3a44e3c3c0f2\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"a4fa992b26069b11\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"b2c98a20c892051e\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"7626d739f643c9f3\",\"/knowledge-medium/src/components/util/error.js\":\"ae27c229132f2447\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"e66a2c6cc4fe4108\",\"/knowledge-medium/src/components/util/suspense.js\":\"159503eab9f20d7e\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"2a2b9082d9f3b76b\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"9bb6a4d8ab2c0084\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"95c85347ea2da622\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"b88a6126c8b5e2cd\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"829ba8d6af135d1b\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"10ac5bb845f16d10\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"f49cc2b05081c141\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"18437f1b9d3a3a27\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"43c998018e796239\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"c62741b412f359b8\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"26dedd4a5fec3ee6\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"e39cdb08e0d83145\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"b9d74438a53091d9\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"61e3b3f65e59589b\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"091f90fc2523b9da\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"69a0dd7a25b3c5af\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"c7c08343bd17ba53\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"e0cbcb65b9fe66e9\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"641ec186bfde1a15\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"5a047826fe392e4f\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"849db709f083602b\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"6937b84aa4d5decc\",\"/knowledge-medium/src/context/block.js\":\"38cfe2b076ef496b\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"f24e54e2648ab30a\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"ada0fda79ab5720c\",\"/knowledge-medium/src/context/repo.js\":\"210b841365b2539d\",\"/knowledge-medium/src/data/aliasClaim.js\":\"c1444855a10be87c\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"f203d720ef7de2d1\",\"/knowledge-medium/src/data/api/blockData.js\":\"6b297201f3bd2edf\",\"/knowledge-medium/src/data/api/blockType.js\":\"17b872025a904ab4\",\"/knowledge-medium/src/data/api/changeScope.js\":\"373dacd52fb13290\",\"/knowledge-medium/src/data/api/codecs.js\":\"3c4798fdf5acdfb4\",\"/knowledge-medium/src/data/api/derivedData.js\":\"fd05d885aef1aa38\",\"/knowledge-medium/src/data/api/errors.js\":\"7b3aa9a8a89ec095\",\"/knowledge-medium/src/data/api/events.js\":\"a27057b7505f31d3\",\"/knowledge-medium/src/data/api/handle.js\":\"d4aa74e87e4c21fe\",\"/knowledge-medium/src/data/api/index.js\":\"ebf5c93ba8ff99aa\",\"/knowledge-medium/src/data/api/mutator.js\":\"0d835a6327b3942b\",\"/knowledge-medium/src/data/api/processor.js\":\"6ceef8e91139f2b6\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"7fe2dfdd8899b5ed\",\"/knowledge-medium/src/data/api/query.js\":\"dba2b9a31f185f2e\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"5e541fa85e7e963e\",\"/knowledge-medium/src/data/api/schema.js\":\"d4aa74e87e4c21fe\",\"/knowledge-medium/src/data/api/tx.js\":\"d4aa74e87e4c21fe\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"a750a100cc76a6f1\",\"/knowledge-medium/src/data/api/user.js\":\"f2d4bc6ed38ba11f\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"39288f3c226d5ad3\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"b80d91d86cc6ddc2\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"3dd63bf89b5909b8\",\"/knowledge-medium/src/data/block.js\":\"6eb29172d6abdadf\",\"/knowledge-medium/src/data/blockCache.js\":\"aeba221bd0fb557a\",\"/knowledge-medium/src/data/blockId.js\":\"4981f796e7a8469f\",\"/knowledge-medium/src/data/blockLiveness.js\":\"18cd9f9f9cf3b64f\",\"/knowledge-medium/src/data/blockMerge.js\":\"c21a4773dea30b5b\",\"/knowledge-medium/src/data/blockSchema.js\":\"a43920eaa1550f50\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"57c4b2d022b249e8\",\"/knowledge-medium/src/data/blockTypes.js\":\"18335cb0641d5ede\",\"/knowledge-medium/src/data/childrenView.js\":\"ad6c61c5c5cce03f\",\"/knowledge-medium/src/data/clientContext.js\":\"2e4cd5e500ccb7cf\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"7477d74b8a8804e2\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"36a2d6a3a7f82918\",\"/knowledge-medium/src/data/derivedIds.js\":\"4197f45a02cf83be\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"1c22804fe6e20c49\",\"/knowledge-medium/src/data/facetBridge.js\":\"5ca2d4a3964fbd67\",\"/knowledge-medium/src/data/facets.js\":\"6e62480b5bf16233\",\"/knowledge-medium/src/data/globalState.js\":\"5ff153e4d1cac77d\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"7d9bd8f1b05e6e5a\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"9003aa553fc6be1b\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"f5b47acf4716314b\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"2d09e0bb856778aa\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"31c7f6dde2d916f6\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"ea5b356926607334\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"584823d85d46560e\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"22f3681c6796b7ae\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"9bb35776c2c20dee\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"7bf8fee48c84e491\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"8f8eb4f499b03ca6\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"61a35bcb5b11b3bd\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"5be30c6588bd2b10\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"608076ccf175c80c\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"9e21a320ea23f8a3\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"1c9b694d70e1654b\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"e8a7097a840c276b\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"451f8ac2caaa32bd\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"4d78b8e74c984e1a\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"c44b955aaccf1ed6\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"fd7d6a8b32d9e408\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"3d0caf9b6caecd9c\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"b1035fd07b40a5c5\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"aaeb70beaecca801\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"a220b8fff0ab27de\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"6b8220767c0c21c2\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"36af40887c25d535\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"3955e574528d9a2a\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"163f576d5265a2f8\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"0ab7560371c3a89d\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"54b949d10fe7fa27\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"8eefe8ec46545b71\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"9354bbddae1f65bd\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"edcf64e1f8fe1e18\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"f73e7d63de74145a\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"62558a9d641824b8\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"6f98e8f64f6d541d\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"88eeeb1cba039782\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"833a7a18c1d4e2fd\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"0ac9da1c6cdbd53d\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"b626f5308a191fc3\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"6e964c1298abf5f0\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"d1d0e90b3b326680\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"0cad539f897a613d\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"da1783bf9812ea06\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"132f4a0f5044eba1\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"f44ab5142fa8aa51\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"02ea2796c5d6281c\",\"/knowledge-medium/src/data/invalidation.js\":\"61d760f787315c85\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"3314c866251d1c19\",\"/knowledge-medium/src/data/kernelPage.js\":\"5b64163725be148a\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"cfe3f5f93cebd86c\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"65d28411881b11bf\",\"/knowledge-medium/src/data/localDbStorage.js\":\"193646c88650d411\",\"/knowledge-medium/src/data/localDbVfs.js\":\"e50bbbf6a344994f\",\"/knowledge-medium/src/data/localSchema.js\":\"4a4c0115cfd81fe4\",\"/knowledge-medium/src/data/maintenance.js\":\"cb3a88e670e76235\",\"/knowledge-medium/src/data/mergeProperties.js\":\"a9df5b42a7c92c54\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"e24307de395a5810\",\"/knowledge-medium/src/data/migrationsPage.js\":\"9e45a1c65ef2f35d\",\"/knowledge-medium/src/data/mutators.js\":\"2ab237db8e7bdb19\",\"/knowledge-medium/src/data/orderKey.js\":\"22bf178cc5b14dae\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"2a3ab1cf1393cd7d\",\"/knowledge-medium/src/data/outlineSurface.js\":\"4bc3c906b4ff7f35\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"8c83438123fdf641\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"5488bf4e16253694\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"7f893df8c60c7aa4\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"8543a5391015f129\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"66bd95e265dab4dd\",\"/knowledge-medium/src/data/properties.js\":\"f839420764783f1d\",\"/knowledge-medium/src/data/propertiesPage.js\":\"6116b7b50667d622\",\"/knowledge-medium/src/data/propertyChildren.js\":\"471aeab5c739982d\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"d34d271bd18f21a3\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"51cc3db88e65af58\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"2e4f5916b7d2af16\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"abd80411d2287ffb\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"09dd0f8a64efddb2\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"e18cf58dccc0841d\",\"/knowledge-medium/src/data/propertySeeds.js\":\"e0b07052125f7f0a\",\"/knowledge-medium/src/data/recentsPage.js\":\"828e14f2e40a4c27\",\"/knowledge-medium/src/data/refTargetComparableProperty.js\":\"7851742a43bca528\",\"/knowledge-medium/src/data/referenceBlock.js\":\"95f0fcf9a6ac4216\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"67edf78a847dd253\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"c81f6c6c9661cfce\",\"/knowledge-medium/src/data/repo.js\":\"b8179e3cad0c98b8\",\"/knowledge-medium/src/data/repoProvider.js\":\"2d2cb4d80cdb45aa\",\"/knowledge-medium/src/data/rowProperty.js\":\"b5701e0c64426244\",\"/knowledge-medium/src/data/searchFilter.js\":\"824bb1fe97a566e8\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"726cbad7957dfa17\",\"/knowledge-medium/src/data/stateBlocks.js\":\"4ddd6702ea04a7a8\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"e5921562d122ddc3\",\"/knowledge-medium/src/data/structuralInsert.js\":\"f9c794b0f1296c66\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"766d664ece01ae75\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"f3a2d441f1c70a61\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"87adde9d010c893b\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"0c87b2d2da136fe3\",\"/knowledge-medium/src/data/targets.js\":\"50e57a900b4639b4\",\"/knowledge-medium/src/data/typeColors.js\":\"8e4bb9009fd18db1\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"a516e519098d987c\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"0d95a3d6cfa6a8aa\",\"/knowledge-medium/src/data/typeExtraction.js\":\"1e70d9e8e80e8c26\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"45fb78f50f9d116e\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"db5278250405cdb1\",\"/knowledge-medium/src/data/typeSeeds.js\":\"171100ce26a594ce\",\"/knowledge-medium/src/data/typeTagger.js\":\"3f725f43970ccd3e\",\"/knowledge-medium/src/data/typedRecords.js\":\"72e9b6bbf9a19238\",\"/knowledge-medium/src/data/typesPage.js\":\"0175455f783b92b3\",\"/knowledge-medium/src/data/userPrefs.js\":\"b4f615842a6f1e13\",\"/knowledge-medium/src/data/userSchemasService.js\":\"959383cd71e816a7\",\"/knowledge-medium/src/data/userTypesService.js\":\"0e71fb9e8c9b0896\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"695e591675aa8472\",\"/knowledge-medium/src/data/visibleChildren.js\":\"723ca4252de25212\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"d10c5674f4f0f1e2\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"da019460cbcca6d4\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"ff86948b05204d9c\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"50c697ad597f5416\",\"/knowledge-medium/src/data/workspaces.js\":\"e737cf397f37ae1e\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"fdad87f3e70f2275\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"2ad6a5d18ad429b8\",\"/knowledge-medium/src/editor/atTrigger.js\":\"cb513707fc91eb4d\",\"/knowledge-medium/src/editor/autocomplete.js\":\"2b73cfa1ca6fc1ea\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"f6fe5ad156e98ff6\",\"/knowledge-medium/src/editor/contentFlush.js\":\"ddd7473443cc53d6\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"a19ec5d5cbceffd9\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"ec5c67850fec9f5f\",\"/knowledge-medium/src/editor/insertImage.js\":\"ae9089f36be3dc9b\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"5a3b6546738c3659\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"c23f98c983b2b06e\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"aaaf2139213b1633\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"1959c1a5dc223910\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"a21464ff8024e578\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"f5b82e388cc15f4a\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"da09a3f4286cf67e\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"caaf24fa91c090da\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"f11b513a12256ab6\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"76a24456a7dfa449\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"36b0b47a44c04d54\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"b4c00760ed8be5ba\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"0d2b8aedd6bfaeec\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"47218e1d0cf71516\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"ef000805ac06abdf\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"e259d0feb437a626\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"c970625ba53aa081\",\"/knowledge-medium/src/extensions/core.js\":\"c001b837b34bef3e\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"c31a2776d7cc3525\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"b733bd5bf083a178\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"68d9120bfd7cd30f\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"17c2bf802910fc0d\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"d6e5aef8eb6d3763\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"d14ecd3c61a916fd\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"3a96355c1536bd76\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"e168205ebfa781fb\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"b838057b10adc3f8\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"31e7f053922aa868\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"921ddc044dabf9d4\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"8c655e67186ab5f8\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"216583e1ec3f3150\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"6e0fde3b803a9f79\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"953ae8a7e70b9c63\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"2d37c58f9460dd3b\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"92e8fbf9ba170358\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"b8e6b2b14649526d\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"38513226d338fa20\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"94428d7c9754c1eb\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"3eb47fad7ad6730c\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"aa4266970b4e0fd0\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"2c437385e1ee6e67\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"6fd40ec3f57b797e\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"5e679946161eeabd\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"fd4874a9377055a7\",\"/knowledge-medium/src/facets/facet.js\":\"708623e438b164b5\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"b9c4573b268a45d5\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"c5ef1f30a508dad1\",\"/knowledge-medium/src/facets/togglable.js\":\"6140530e6f4ddb10\",\"/knowledge-medium/src/facets/variantFacet.js\":\"fda198f9d1c6a4d2\",\"/knowledge-medium/src/facets/verbFacet.js\":\"799fba0caaf5f1a6\",\"/knowledge-medium/src/hooks/block.js\":\"0c082bd7d6f70b2b\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"6a420d89e5d5c083\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"b421303275c57ac2\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"7dd39c2e74b50caa\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"40405e69e0a42bbf\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"290e3724c0764506\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"4dfcc4ff354ab664\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"842b84b05c6b7ed8\",\"/knowledge-medium/src/hooks/useFacetValue.js\":\"d3c28d366d64b101\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"f1b10641210b81cd\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"e3143a26abc814ea\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"421e8c9429d5e689\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"bca879b342797a8e\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"184e49281f330357\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"d14e6b15e1f498b1\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"06eb5976bb817728\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"5e96b8821f29e162\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"0563bf2bd589824c\",\"/knowledge-medium/src/lib/utils.js\":\"cae81fce4ce67c4c\",\"/knowledge-medium/src/main.js\":\"6fa07ef46e696ccb\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"d09c2f2113a7ad3e\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"c3da0f768a663f52\",\"/knowledge-medium/src/markdown/context.js\":\"b5ed460f0377371e\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"256c3deefe32cfbc\",\"/knowledge-medium/src/markdown/extensions.js\":\"861b404861d5af7c\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"b21587a6b323a218\",\"/knowledge-medium/src/minimal-editor.js\":\"02582a79da0e15bd\",\"/knowledge-medium/src/paste/armedCut.js\":\"f789609e7c5c68f9\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"3239f1898e7966fe\",\"/knowledge-medium/src/paste/clipboard.js\":\"b17faf6a0d07d5b4\",\"/knowledge-medium/src/paste/decision.js\":\"5d670da1e90ef9b8\",\"/knowledge-medium/src/paste/operations.js\":\"9d0aaa5fb7fff914\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"d42caec6625123b9\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"5fbed572d6178e6d\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"7f4426cbc68a897a\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"ea99f1952ba66b9c\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"3d3527758ff0fc6e\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"0d295b71b49ce37a\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"fe186f76376434a5\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"fca1910535f41081\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"07309c6575a1eac9\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"2fa912c54cc47a1f\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"b65cd8e0c32fb7eb\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"344fb9439dacc436\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"03074f04340bf234\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"7c6007090ca2b929\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"50592c0e4f686a8c\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"465b5bf9464f5bf4\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"4a4f10431f8c3f75\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"ffc516f6d1904cf6\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"6252a22743adb927\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"925c1c523e556daa\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"130c6fd73db8a3fc\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"3920eca8f264d1cd\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"d780029f945facad\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"dac575f33499cd9d\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"ee3bdbe445a6b0b9\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"75edb8c059205788\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"a4fc795bfa783084\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"976aed8c86e7241e\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"7c83dd0863f5477b\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"e1865669a6f0d2e9\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"849ad0e1d2941802\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"67b9fa4cedfd8971\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"5869b3682e8b6acf\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"11f42fcf5d153871\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"0481e0d2d9197fef\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"13baa0b7ff3c3efb\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"fe8811bc8312e5d6\",\"/knowledge-medium/src/plugins/agent-runtime/dayPropertyInputs.js\":\"8105b7a570c39729\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"c3f6d4bed28d07c2\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"ccc5783289a4268f\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"afc370786da3e51a\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"9c734ca03c471e81\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"73dfcf1b1f484826\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"6be7e866d4e25830\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"ee76dd41213aed41\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"4380b2f1e74238e4\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"ec2f1ae3eea959d9\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"9aad6c713d5198c9\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"439657fcacc388d5\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"8e3e1abbb48e783f\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"e1fb218a7d7fb734\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"854b0c5991a95fd3\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"edc461b4c411717f\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"9e59527940a67f6d\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"97f0108790800d4b\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"e2cfefc9a7604745\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"80cd2cd8088f5a8b\",\"/knowledge-medium/src/plugins/alias/index.js\":\"0507e7cb2444f6e2\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"692c6423e358d96f\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"4ae649359727dd48\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"2551b9e41b19edf8\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"4f1cb799c371742a\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"daa89e3796081335\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"b378a72065e1a7e4\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"2da8b4de69df9ee5\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"3209c37bb8d2d9b6\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"5321e04fd860573d\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"41d62c1c932beee8\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"7ff9893ae6d3b12d\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"366cdbbb1effe1ff\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"77536189e439eefd\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"5e264278dde443ec\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"0acf0dfe224d30e3\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"8728071e783e9651\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"b08f6038117dec71\",\"/knowledge-medium/src/plugins/annotations/marginAnchorLinks.js\":\"4fd8707f827a0151\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"448538997db1dfbe\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"a4da8c3676e6cc93\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"8be85dc006a0a08b\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"0ed0afe4df262987\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"371dd969668e5db5\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"0bbf06ffd4208f83\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"3a8213a1738cedbc\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"ba6605e9affa1ffe\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"3fb8fc5ae133c701\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"fa8e8307e8f11ce1\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"c6aa56ba360d61d1\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"c6af4d3391bdbe40\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"db85fbec1b16ca15\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"d10e812401278b11\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"f8138be6189a067f\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"f08f0e61c7faa3f1\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"30804bc5e07216c5\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"b1f5b890e33c850f\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"571ab4ebdf084737\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"c5ab8fc32ab5271b\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"2afaf39ff6cf829f\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"c1509cd7336a3308\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"a5d5caab49f78f5c\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"db05b15169b1eb69\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"245394b878474f31\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"de570c7f68e85803\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"85083128e3122660\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"41d757660cbee673\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"a4bc07686410ac69\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"db088f17f4c18695\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"6d25737e25058bed\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"621254d2293ecba9\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"0c88a403f6be604f\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"963a451b37b2bef1\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"fd9a7f2ca8fd41f3\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"ea5ed75a6b7ad623\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"001f9d0c873b96fa\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"af2564b29da29bf7\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"b9fddb8e6cebd1dd\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"c9161ad1d3998075\",\"/knowledge-medium/src/plugins/attachments/browserMedia.js\":\"24862517373392bb\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"8460db695a6e3fe7\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"93489fddfa0ef157\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"4e8c6c0a874c06c5\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"81ae3a64e58d6bd8\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"041431b75fdd93a7\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"cde9bff8d538140b\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"4556dcf42fbebbe4\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"507e33c548f92fff\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"1d23a1d2661e529e\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"6b8b897fc902c657\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"e98fcb7e1f6d340b\",\"/knowledge-medium/src/plugins/attachments/mediaLanes.js\":\"e39379565be27080\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"848ae1e7518b31a6\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"52e872c8ebbccd1f\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"fed141659a7a1e4e\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"717cfd256ad1b9ae\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"3171100ea34e7cbb\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"89e007a7f59e21c5\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"93c649ab1e120d6e\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"decd2544c89efc6a\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"77918f6688f22de8\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"854375cdffa6fa27\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"2c6e08e90dab9744\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"bb63114d862637f9\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"5d43adc39afa1153\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"a0be79b28efb0b94\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"4f437bcec4ca4711\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"073526c0896afe5c\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"7d39bf908f8617ad\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"80b146d18bfa877a\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"eb47f9d508548360\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"8e142a055c9b5590\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"8755865cb878fa8e\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"f3859a99b7452bcb\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"8937ad41f66dad1d\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"b79876f85a92edc8\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"1b83953a070c9115\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"4c78c42af8a7163f\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"70a68362de029694\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"f521f5939541fbcb\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"1ca2898a709f96fa\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"754d06d32fb7eea0\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"20c5bb742fc24325\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"443bece32df571ca\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"1de6b20cc2bf1073\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"c2d8faac7b778177\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"8f9da0d1800f6b3a\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"edf8faa08c5a6804\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"a276d519e002c3f1\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"cdfce8019b2c91be\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"2ec6e6533afe59d0\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"a6d5ad8ba64b1f88\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"5a3f743b6d0ef1d4\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"d7b4f928da1f0170\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"0b2bd0509fa55202\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"38c608821d758cd5\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"c88072364ec07f40\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"59b2d2e170a84531\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"3665ba0e6fc99676\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"b01695b206d7f86d\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"f45c8f484ac62ef2\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"d876ca1e3bdb4fde\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"bcc63b119ddd9bb2\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"b6b48c97ebbce545\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"5ce12ec6d2f9ef01\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"055a6d2313f014f0\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"f549447bc4073ecc\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"ea3ca6c3bed92cd3\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"f0a1acee7bd95dab\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"ad57529ad14dae11\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"cba537408b1ba589\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"1f2d612e3e09cb3b\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"a79c6ce5584d4be3\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"79a16f4c17ef8b12\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"003fb6236feac359\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"2d330c22abd14a63\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"8feef9bb7055c643\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"58cba630ae00be33\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"46cb497f3493ff86\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"8a8a1771b0a91cab\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"589ec82cce460cad\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"036acaee6aa41408\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"1b0f08a796180856\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"3f5dc0a045c6e5b7\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"fcdbbd27a15576bf\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"dc464957caa51f82\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"0cba8af42dc98c03\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"d13bec7dd7d087cd\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"9e61e701dce45a35\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"dd69eb3d1e088e93\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"4a9fcd6c525c3f56\",\"/knowledge-medium/src/plugins/character-counter/subtree.js\":\"c1078cb27dc08507\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"ebc0d7b3b78b7804\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"73332824dfb2e56f\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"d95adc14b3252c27\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"7f6bda8d080ec94f\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"1d0dfc1d2222cddc\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"637ad604ed0b2ad8\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"80ee52782b01b3de\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"cc7ca059470c3571\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"631c32a5590bb17e\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"a463b93d667c8b07\",\"/knowledge-medium/src/plugins/contributors/ProfilePicture.js\":\"4bf02869bbc86011\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"2945be1f60cec555\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"89be2810846a8b47\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"daccd6697fb5715c\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"c15fac0922b0d2be\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"4fdbc2978d38a46c\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"918f54dbc85b922f\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"b50acee2d6becb41\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"466f21736b77b08c\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"99b3b9678551c203\",\"/knowledge-medium/src/plugins/contributors/useCommentAuthor.js\":\"d5f0b174062e6a8a\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"b9d08cb44e9a74d1\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"b53c75518b279f60\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"29874961d437d2ea\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"01db8393fb3d8943\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"e0152d72bf59856b\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"1a74fafc34aa8011\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"6c093d7b2fa304cf\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"5aedb3284fd89db6\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"d3439b7260c83cba\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"9548d3e43d5a7581\",\"/knowledge-medium/src/plugins/daily-notes/DayPropertyControl.js\":\"add0987217b54bb2\",\"/knowledge-medium/src/plugins/daily-notes/DayValueReferenceControl.js\":\"54a6f3c52d5cfff4\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"ab50787ba3904937\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"af477a0f89bb6f95\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"8f417cfce700273e\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"906e6be00f2d1d58\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"3b7a0d7a11929b74\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"3dab8f5b7eecf230\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"19d57562d5f1d81f\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"eaa1fe73338a6296\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"64a518e1b1318ead\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"d09b96255ca304fa\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"55679648f4e3150b\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"36cdb2be28c8eb13\",\"/knowledge-medium/src/plugins/daily-notes/dayProperty.js\":\"ec8f7beec5da7230\",\"/knowledge-medium/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"9c6a43a9b2daa9e8\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"02dc80bd9897e908\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"1e12d8464c2b19fc\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"41507d2c5da5fe5a\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"1287949389a7cb63\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"9da753fb9b73e436\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"987dbcab50f3eebc\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"f2a498fb01c1e8d7\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"c167727c503dbdb4\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"cb62ea06db88dcaf\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"360a4f5d95235e5a\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"34866769d13f388f\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"f1162696f9933d49\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"6090d9b9004cc103\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"b7b5596963164be5\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"8251c416c50dd909\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"a0cb940b3782be5a\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"bea547c7b3b87bb2\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"b217e1a08d28bda6\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"2ef45added88a82b\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"8d48e4bc1b9833c2\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"f7a8b28e4649f98d\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"e8fe30e69e119f6f\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"0339ce9849b7fccb\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"9c6c74435ac17ccb\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"802285fdb018fa2e\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"b347b20c13afc0d3\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"966a40e8a164762a\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"4acb9b18ef9b2497\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"c272d0602a81be8b\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"b5a937a91a345422\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"2a13ff33cbee920e\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"43fe4bcbfbb6a0a0\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"7aa2fb7192f64710\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"70ead5879011b370\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"95b1338ca8aa4ae2\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"297d477e890fab87\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"3dc8f300e9e19d05\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"e7f09657577109d4\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"699944e34fae6f70\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"6945580adce447f6\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"a2223b9591bfaa67\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"f94b713eeabdd15e\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"e3108c84953ae289\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"3bd3d7490982b3df\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"f1ed548f1f83c23e\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"b47c7b9bb52540b3\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"db80076122e79089\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"678872c28006ae84\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"5246118a13909cbe\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"13aab5a270eba115\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"b6c60cb835401952\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"6e69174ead06769b\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"4cc7ee7fe1e24355\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"75709a6e3a2963af\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"029d1440a7003224\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"1061fbf75696635b\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"1f94d2eb84fd2edf\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"ddc68832ea1a0c76\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"4a638bfda79421f8\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"45100f9e9be626a0\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"b4a849cb56a7e110\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"c8296961f34ee19b\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"aa5c8ee3c1f1f48d\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"8a4769dd2d0060ee\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"ad3cf418238f3489\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"e144a0844e2ec70e\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"1d9ab5c29a748032\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"41327b3b8f5be9c6\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"aed1eb67fc3448e6\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"b12365601f37d2e4\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"1bcd6d89a4ac11ba\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"413efc35b69ce03c\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"7068c942f81ae654\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"392e1b65da74eaef\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"0b297178e3fdecef\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"e40dfec6051e1841\",\"/knowledge-medium/src/plugins/geo/index.js\":\"0ed12c64e54e5545\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"79a8baf54974c783\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"7a3dbed162337848\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"f939314b54f28778\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"9c827fdb833a31f4\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"acd6754da54b3ca3\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"e2c1482137a0015d\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"d142cde550d48f87\",\"/knowledge-medium/src/plugins/geo/query.js\":\"3bb9dbaee2e24d41\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"f0c6d2a51ab6d71c\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"55eebbdc5c0437db\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"c1efb2821c689d9c\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"eba4c0b22238c643\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"6218aa5b955443ce\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"45e1b2cb57314081\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"0cc44cd90b8c3a82\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"372a8634c0a9fff4\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"c3867a2097c4de22\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"77638e6140fb0ae5\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"e7bc05e1f99b17b2\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"9b3cc1383f7de3ee\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"4627a3e59954d2f6\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"203c3c7599847e1b\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"6f9a5d353ab401e2\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"a2598d416e7d9cb7\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"312e7f7eab2c67b1\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"1fd1ef6c54b6f521\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"c8f3a7c2c90e65ba\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"3a108eb06203bff6\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"cab537c670d0f4d2\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"0b92dc0a425f2a8a\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"dcd0a4823a1cee67\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"1fd1b03edad43bd5\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"a728da2ccf117ea4\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"47ce551cedcab977\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"80126bc5bf50adee\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"41f8f4747b33ba38\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"91ee0d0e8d3ee306\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"0cf8cb0763bcce61\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"926a60e11d00f60f\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"47f1bd9bb9539449\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"8de2a62927f8c246\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"9acfe09c580322b9\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"2dfe8322ad7e5fa3\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"bcc07fc6fabb7c8e\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"4f5d6ecb70e09a6a\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"21d03b1f5e7229c9\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"3b65a95517c28078\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"20b8e5401cf654e8\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"b24c9940648b792d\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"f4b1b028e87ca006\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"10b7c92dc1764da7\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"1b3e2041c451eefd\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"d4fb7b3f5ad21e02\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"7e7c950b418ba237\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"e122bb40b55c5f09\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"de7ce5bc93e4d0cc\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"58d068affc9e8141\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"680431a525b85f86\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"aad934c71ff05458\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"535f66108055f917\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"c29c421e5656236b\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"dc1b857616c150db\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"c38512f20b02a4b1\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"a1e30692f0d55ad2\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"294c71de6bd5caf7\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"d9360a1912a6fdd0\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"351ab4e3c7888aa2\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"c737f370f094ca2c\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"792333101c5ce0cb\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"63b8bff327f50558\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"afcd87ff80c4bf1d\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"33f23cbf694f4889\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"60b858a423b1dfbc\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"d6f90b266deecef2\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"1d4adbfa3f8dbe0b\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"6982d038e59223c6\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"e9f0b2580f480a6a\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"c0a942e3916a68fc\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"0b3dc6c8bf7edd03\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"95840a017cd69e5f\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"1e79b2777ebbde53\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"897a8b2344ff3a08\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"201691d08f700226\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"deb4af528f097afa\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"fbbf6134c10ac055\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"898f3875f724ae13\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"83da878767f403df\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"5cb1fae590d9807d\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"0104cfa8b731f1c9\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"6fed8894fd501f51\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"4bf599a222de9a43\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"a9993b3bc3f186c3\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"d50d4787518e8b1f\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"46b12e937865939b\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"b5430398b4511485\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"8610b28bdb8ee33a\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"585cd866b527d70c\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"fe2e876305f2061f\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"f9332a359e9ec082\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"aaed4f43e75fa82a\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"70719e248938c99d\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"ac01e367b14bd1a9\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"caf83579bc08f97e\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"c60614127e26a71a\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"d0a091dfbe06fb21\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"2fb9f4d2ee493694\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"10ca9616a1c9c33d\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"f5b8084e1d77f082\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"d957e6d5419542ea\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"d5c626083a672c12\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"6c49156aaed4b1a7\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"9361b3bae9221e05\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"c2d4367f29c67f92\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"37beb8f87dd77d81\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"7320e9343a8fde07\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"01df5bb0f4e48c61\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"ffce6e1df84b6ee9\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"cdf99d0e3d0b389b\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"d71f6194908513de\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"113effa78e18aed0\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"01ff4bfb90560d7e\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"05e75a7403babacf\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"9a0797be5cec1da3\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"030651fc55c069bf\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"b681593abeeef6be\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"71f49e8085c1ab04\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"047b40e85a34cf70\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"ed26fa829eeae744\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"d6e271768a350ec4\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"e9c0a95f07605fb8\",\"/knowledge-medium/src/plugins/recents/index.js\":\"f4c909b49f5a5e45\",\"/knowledge-medium/src/plugins/recents/target.js\":\"26c1c9543f21fa62\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"463b34cee7bf0840\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"3a339aa15bdd877d\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"a39565d98a38e895\",\"/knowledge-medium/src/plugins/references/index.js\":\"e930354af0b5c802\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"95def35cf5bcf84f\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"0c829579632ccb90\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"ecf3329bcc571a9a\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"c34188d1e2931101\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"01d626cbc3e9947f\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"0accf6f68351f386\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"aa02817aef88d9c5\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"0a5a3b2b4ff6a062\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"abbcfafd3ecbb9f6\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"2edbe9d51dab3ff5\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"ab3c8f1d7fe9f334\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"91347ef48e1b259b\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"23d456c4abd6cf3e\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"041b6b353bc82f3f\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"012a930d4bede720\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"06853c6a60eae145\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"98199132d92ec702\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"8cc7ed49bf42977a\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"d351337e4088680d\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"2e1ea48da6d8b48c\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"8abd14bc4ccfe958\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"e881d647bd8e2d96\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"1f5688eb1304bd25\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"16ea524c0c179439\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"1acef1e877f8b3e1\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"772362c4c2fcdea0\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"331deb68b5f7b9ac\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"ffdb1ea32f272d39\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"5a734001502ee397\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"455936a7cd8e87f0\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"7a625718d72f8068\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"ec7cd7270446fe97\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"891286ef042db4e2\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"e257568d9ac1521a\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"ef2dcb8474496894\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"694a79dd1c048d37\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"043d48cc0b92a10c\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"07c9125efb4f5058\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"b44e58a6cbf547ec\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"bb19f1259104dfad\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"a03ceb272aa4c5a4\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"53381e9a8cde9775\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"dd6148e4de4d3d90\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"5fda0d84944a944b\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"9e4f047e3960397f\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"b3f085815e86a3c6\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"a65f1030cd141410\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"75565df1abbc6712\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"82b9c9b64719434c\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"f8dbd600992fefb2\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"c8b81f0a5fd96ae0\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"6a5c269863c5adaf\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"26145c4c70bd2f46\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"7ad8f8da77529d33\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"4a0a906634926e1d\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"3e40884d66f9f9be\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"f370376c34ad9bdf\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"6d4e1a2ccc8fad0e\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"4f24b99068f94b33\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"233e93ed991177a8\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"b6682df2e02db7fe\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"52936554c39ff641\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"d4643ecf1e4474fb\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"8c28a4d9197c6262\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"6dcde7c3fad6061f\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"c4e4f7353f00fe07\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"a47ba20578cf1820\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"6a9b663e1d7fdcdb\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"d0d556d831adb273\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"9767fcd92086d3cc\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"b3e612aaa17639ff\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"47ea3b807c503264\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"74bec790d6012d8d\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"92a0601d3dc14008\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"4d156d9991ab1b37\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"69ad8da31e95a2d1\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"4bd8b878841d2665\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"660f28260a5e3345\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"471bfbbb0e1376a8\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"96e0c1079b70379c\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"c549ffe6a1fd380a\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"731f25ececf44294\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"84af4fb44c2f4c97\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"aa1b58daf2706c10\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"51f77daf600630eb\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"e293c1607bbb3639\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"71216055b4ab8759\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"48f4d2f812f89a82\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"dfe1f9e45b108065\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"d0b159aadefda3d5\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"d3a51aa846fe341c\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"0c6d2f3ebecb09e6\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"f5dda00818afb6b1\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"6004e45a4dd0116c\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"a777fbb14b91872a\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"e58e434952453b89\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"29ccd4f1e9b64e42\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"89eaedd6a48c9b7a\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"824a3ad82cae6525\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"1102676eb1b8eb79\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"e2354250f6643f97\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"06d349146291378a\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"dea21962f41aa465\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"a11ac658d4304011\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"161ed5c99a9c4d67\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"6034bb1acf6653fa\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"e1dd1aa88ca1a899\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"c9f30bfd5218bffa\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"2d278e92b34af4b6\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"92c091c960cd927d\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"bfaf7be698e13389\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"1aad4e3812a0c388\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"27b32008b58c7d90\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"7fd4727c4dcb4a1d\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"2795c765f4cf8cb4\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"aaf6bda422c752c8\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"33f748127c15039a\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"1e8e224a9c136a36\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"7b3969a332add3e9\",\"/knowledge-medium/src/plugins/tables/childrenViews.js\":\"1442c58d77f69cc8\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"5b9f7d6462450248\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"e160a4d72a145979\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"f535f883195a60e4\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"d09689bc7c89ef62\",\"/knowledge-medium/src/plugins/tables/index.js\":\"fd8200fd4bfff42e\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"fb6680a31673c051\",\"/knowledge-medium/src/plugins/tables/model.js\":\"b69735e7dae3e0f0\",\"/knowledge-medium/src/plugins/tables/query/QueryText.js\":\"a9ddad5d191a9410\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"c66c8fa3ac31dcaf\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"cd3bbf81e320460a\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"643e5d78e5a7ba25\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"f98613ac152d4ec4\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"b049159b701dfc7a\",\"/knowledge-medium/src/plugins/tables/query/registrations.js\":\"697936fed2e10d18\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"af5123e657d8304a\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"e6f97a9d4de2f55e\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"3bb1f580485fa698\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"a210cb5d753487ef\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"4dd04d676d53eb2c\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"1630d846f37e6a39\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"0be04db79cd50a37\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"565c1fff45417ac7\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"cea54ad1d4252d80\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"d96fd0b0212e0389\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"0c74c7801b26e310\",\"/knowledge-medium/src/plugins/todo/index.js\":\"318dec45048f417c\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"16bac82e5c8ff3f9\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"3ced1ca22d91a43a\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"0ca5c6f31b1338ca\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"3b32811b34208aa0\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"6c30384b7504d79d\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"e40f6d92769c0e37\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"08f007b67b84d9f1\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"30eb8b991af6f0ae\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"a97c20a9abf8cccf\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"507fe81547f7bf9e\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"f01511eae70c4987\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"f9b0a1ad70147b7d\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"10e0f24f0b8aa06d\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"73b3c5696ccbbfb9\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"edc086d24800d34b\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"79208743df25a568\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"87e3d72eb337c084\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"0bc58043302c6ba8\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"a9ad0ac8aad1e279\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"52924d486153ba1d\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"d49d3d47d375d4b5\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"0a81d98e8b8c10b4\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"0d7657160060e100\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"a5673828ff023b08\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"6782ff905989cf3d\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"0c639ff7d8b93b5a\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"49c20484bde08628\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"621a2e071645576e\",\"/knowledge-medium/src/registerServiceWorker.js\":\"29c2f79501053079\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"516f2dc9901f3835\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"997f89cbe612b327\",\"/knowledge-medium/src/services/authStorage.js\":\"8211d13d6194f894\",\"/knowledge-medium/src/services/powersync.js\":\"560f3ea954c4ba73\",\"/knowledge-medium/src/services/supabase.js\":\"02146ea6ce5a3173\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"fd2aa60fd1d06f8d\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"e58dfbef0f2f5591\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"3ceb08b12015d953\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"9d22bf827800abb7\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"804b0921149bb827\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"e0010c00e26826b0\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"61221c093f19b4d4\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"ffaf2634eccb7d59\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"93089a01a14606e9\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"635852995abe46fd\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"1548134a5168f2ad\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"c0a31f4c765ce269\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"559d04cc6f1ee5bf\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"38f3882c87a53568\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"dd8205a2fe2c5562\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"aa321b53039b236e\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"aed481b8428bec17\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"fe568424623c1f6b\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"78132ec70887a1c5\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"bb358c3e60b0a1e1\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"ec0cd87b0b68d3d4\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"ec855328679f9213\",\"/knowledge-medium/src/shortcuts/types.js\":\"8a1f9b92c3ce7582\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"7f7267a2778e0062\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"396fc50e39e8542e\",\"/knowledge-medium/src/shortcuts/utils.js\":\"dbb17b6bdc8b59cf\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"7ce9478832193c9a\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"a695c7602dc4f0e8\",\"/knowledge-medium/src/sync/byteTransform.js\":\"bf853f4053cc0046\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"7b45a5a12b1d92b3\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"28132be7f685d7ec\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"3669a46d06b2272e\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"93385cc288709881\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"b7f5bd0a43681691\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"313532a88b7a5da4\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"a8d3dc53adcd04d5\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"a2006baf7ca8963d\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"3e5e8285dd7facb9\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"4928561ba71968ba\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"a51020c6d8d411d8\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"70c2e6436a622693\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"cda1d9b96a7d00c5\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"97aa22f75c80c10e\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"3c290d91887969e1\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"36d74de0c7ac733b\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"8e9251d6f63456cd\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"645e2e1375bf1f71\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"d5b8b43b50c2c56d\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"37909c54fef87fd8\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"d2a7c26a4f154b97\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"fc59c384fc1aa9f3\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"006c04a4ff2ffead\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"b7aad7b42afa83f9\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"45f3d90e7f0be9ca\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"8da29222cb4ce001\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"cdbf15660c18c76c\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"50e9a10f31bc4a05\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"802a777bed4eef3c\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"2a4b88b32b688836\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"2b423b15facdfab5\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"844a0c8d80e72676\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"ddddfafb710c0e31\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"23a9f0777feaf7a3\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"9b8e7fb52a68e74a\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"d7d361bf88f20a32\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"db3a5699a08e29d1\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"2ef7a8862406f176\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"f79536be7dc123ac\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"8924d9a76dff0e61\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"2b34e1e6f5a2b9e4\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"d2addcbd2443e7b5\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"c710a3b5663e34a8\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"231f274e1a919679\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"df5e8d9b9eb9fbef\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"3a0b267989d5ff79\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"09dd6249c84d989d\",\"/knowledge-medium/src/sync/transform.js\":\"55e4169273419429\",\"/knowledge-medium/src/themeBootDefaults.js\":\"9713030bacd3a794\",\"/knowledge-medium/src/types.js\":\"4f2d1629b511dd68\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"4d66f51b7c489624\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"211db35376380a6f\",\"/knowledge-medium/src/utils/array.js\":\"9f08119215b9b0b9\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"958d87d3abb3d4a1\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"4a24d70d7a015551\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"9c7302bf2270bdf9\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"af34195a88721c01\",\"/knowledge-medium/src/utils/callbackSet.js\":\"d5afeed6f2f6834b\",\"/knowledge-medium/src/utils/clientId.js\":\"1d322b4a13ebf179\",\"/knowledge-medium/src/utils/codemirror.js\":\"a1ca84d89e4faa22\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"4ade8bb08ce554f8\",\"/knowledge-medium/src/utils/copy.js\":\"fc83b7d17ef4ddc0\",\"/knowledge-medium/src/utils/dailyPage.js\":\"903fb78fd1467a1f\",\"/knowledge-medium/src/utils/dbForensics.js\":\"bf3aad0a4c996a1e\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"f1a9dcb6d4210bf1\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"03ed67daa937f195\",\"/knowledge-medium/src/utils/dialogs.js\":\"8cba574e519ef5dd\",\"/knowledge-medium/src/utils/dom.js\":\"476c0988f4d29511\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"8a8545b7f6a3101d\",\"/knowledge-medium/src/utils/drawnWalk.js\":\"10369124ae2d22bc\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"84e85e122720db8c\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"4f3e6209c7dd2db2\",\"/knowledge-medium/src/utils/flipSlide.js\":\"9e4052077c5d50dc\",\"/knowledge-medium/src/utils/fnv1a.js\":\"7517790fb3932cc0\",\"/knowledge-medium/src/utils/formatBytes.js\":\"41d7da46d18e8e14\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"90fd45494a0d9977\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"2cb92a51549ca334\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"f6b18c9168a1c4f5\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"08da0c522509d22a\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"d09b6ad5591520a1\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"66409af56878948d\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"4da390dcfd373cfa\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"b7e0df7b824009fd\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"78bb2102e641c124\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"f25758f1750081dc\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"6e441f3c1affc3f0\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"eedb221a2cf6a514\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"2860a6a22bac3567\",\"/knowledge-medium/src/utils/markdownParser.js\":\"0a9e2e65f185920c\",\"/knowledge-medium/src/utils/memoize.js\":\"33bc60fda282f182\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"5ccd5ceeea30b459\",\"/knowledge-medium/src/utils/nameList.js\":\"0df98928cb0e9f3c\",\"/knowledge-medium/src/utils/navigation.js\":\"03cfb6eebd7feab1\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"ddb5aadb97e990b5\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"f26b1ee18143bf10\",\"/knowledge-medium/src/utils/panelClearance.js\":\"efb269998500d738\",\"/knowledge-medium/src/utils/panelHistory.js\":\"717507faf2b8bce1\",\"/knowledge-medium/src/utils/panelLanes.js\":\"c826c952b364a1d3\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"7e48ffb89e210ca5\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"65fe560a17584e75\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"16f39eab77e49c9d\",\"/knowledge-medium/src/utils/platform.js\":\"becac5bf368d0487\",\"/knowledge-medium/src/utils/pluralize.js\":\"a1b979d97c871248\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"8583b004c254b105\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"c0bf8c5ab84e8a83\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"8dbbdbe1aebedad5\",\"/knowledge-medium/src/utils/react.js\":\"fcef72563c587371\",\"/knowledge-medium/src/utils/relativeDate.js\":\"d470d962431c09ec\",\"/knowledge-medium/src/utils/relativeTime.js\":\"406ed2e749919711\",\"/knowledge-medium/src/utils/renderScope.js\":\"9dd2ba9581aca125\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"ac3735cdad86d5a3\",\"/knowledge-medium/src/utils/routing.js\":\"d125d8c690ea7737\",\"/knowledge-medium/src/utils/safeMode.js\":\"b1fdec91c398ccda\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"9ee626c9262100a4\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"56a5d8e11decbfc6\",\"/knowledge-medium/src/utils/selection.js\":\"a4209c9a3c2f3e52\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"3a7c74ebf4206027\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"e0f413289697b52c\",\"/knowledge-medium/src/utils/state.js\":\"d94c22a366c24581\",\"/knowledge-medium/src/utils/string.js\":\"68f1b527d5c67402\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"2e8aef857cd49e10\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"c37d399f277f2996\",\"/knowledge-medium/src/utils/toast.js\":\"3c5e45228c847625\",\"/knowledge-medium/src/utils/toggleStore.js\":\"cacdf5f8dde2c287\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"9e06d5bde44c2d3f\",\"/knowledge-medium/src/utils/userActivity.js\":\"a9f2ad9aad7b4996\",\"/knowledge-medium/src/utils/viewTransition.js\":\"20d528781fff9e7e\",\"/knowledge-medium/src/utils/viewport.js\":\"3ff4301c09b7b144\",\"/knowledge-medium/src/utils/webLock.js\":\"a6074bcc63321c85\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"57bcc4c6e39a089e\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"cf175b43040d8bad\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"126119d994d1516d\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"11daa9604ba963ca\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"0a345ecf6e31a0d7\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"fda14e8b913ecd0d\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"e70585a8ca6fdab1\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"3e269ec96eb2bb4c\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"ce41c4e5bd6c18ba\",\"/knowledge-medium/src/vendor/react-dom.js\":\"2fd43e96c334d86d\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"35e7d5cad78dc066\",\"/knowledge-medium/src/vendor/react.js\":\"261215e93ea51f52\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
