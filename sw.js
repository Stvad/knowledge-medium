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
		buildId: "25aced5e5eff-4f75291c",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"8fce44fd65a5babd\",\"/knowledge-medium/index.html\":\"8fce44fd65a5babd\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"a86f8d93f99e872f\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-DYHvCRzI.js\":\"f71953ffe489de9e\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"d83074cd477cac1a\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-DvS7QUi0.js\":\"ac746b4cef45dfc0\",\"/knowledge-medium/chunks/FacadeVFS-D94FTTHT.js\":\"6782834e8e8dbefb\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-C0kRIxpT.js\":\"d88d4cb6f10841b1\",\"/knowledge-medium/chunks/MemoryVFS-D9g1xOp1.js\":\"457c3fed30aa5200\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-DG3cSdN6.js\":\"f0bd075e769b6cef\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-BaKiTe8z.js\":\"d153abaf299661d4\",\"/knowledge-medium/chunks/Preview-DZuxObUj.js\":\"bb0bb7a86a021ed3\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-DPiWHT3c.js\":\"636e7b40d3ad868b\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-CdnemFw7.js\":\"7bb9a14cdc8cbc32\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-2AA6UZ4F.js\":\"d153df4ff1809ee4\",\"/knowledge-medium/chunks/react-BPsDGD4w.js\":\"4d30f31506a60ffe\",\"/knowledge-medium/chunks/react-BsNTB8kk.js\":\"163bc19f100a136a\",\"/knowledge-medium/chunks/react-CF9fYRYq.js\":\"45455e9c38d28a70\",\"/knowledge-medium/chunks/react-CQVIoDIP.js\":\"98946880d59ef158\",\"/knowledge-medium/chunks/react-CZYf2X0_.js\":\"6372332552be1242\",\"/knowledge-medium/chunks/react-DZ6Ben4V.js\":\"20dd508ce05e9387\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-Dvw-1wzR.js\":\"ab998b5824f8ccb5\",\"/knowledge-medium/chunks/react-dom-server.browser.production-DHeyxeZ_.js\":\"f3a9a14332953279\",\"/knowledge-medium/chunks/react-dom-server.edge.production-BSgsj7k_.js\":\"fd3442815ddb0c20\",\"/knowledge-medium/chunks/react-y_relukq.js\":\"26d5d096e21b4d21\",\"/knowledge-medium/chunks/server.browser-B4P7wVBr.js\":\"36e2c98ffce26a2d\",\"/knowledge-medium/chunks/textarea-BSsWrO0Y.js\":\"89e37e544b66e8ef\",\"/knowledge-medium/chunks/ui-CbpkIdD6.js\":\"e021b7c80e6a004a\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"72505e9046a32f46\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"5ff056c96daf472b\",\"/knowledge-medium/src/appUpdate.js\":\"2a05ac2e68978386\",\"/knowledge-medium/src/appVersion.js\":\"48f8693d4afdf706\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"6e7afb67234c2c07\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"297db61c2b0b6c55\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"3d2a49fd30644ede\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"32ffb0ef32ea267d\",\"/knowledge-medium/src/components/BlockComponent.js\":\"e69bbf579f3671b6\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"91b4aab712dd60ad\",\"/knowledge-medium/src/components/BlockEditor.js\":\"1a47533cad54fa94\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"ec09fd1e237c3991\",\"/knowledge-medium/src/components/BlockProperties.js\":\"60406c6643251a01\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"ced42587f3dd4c79\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"4fd43d84f4653ff9\",\"/knowledge-medium/src/components/DividerHandle.js\":\"418bd20887fb4fd6\",\"/knowledge-medium/src/components/DraftEditor.js\":\"7a4f07e829d12905\",\"/knowledge-medium/src/components/GutterPill.js\":\"be8263c2c633d470\",\"/knowledge-medium/src/components/Header.js\":\"872a8034256b85da\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"ab495e17f37a450f\",\"/knowledge-medium/src/components/Login.js\":\"a01169837f66ee98\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"f0bde13ae1d5f2bf\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"921d0554f6f3bcaf\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"d62a6f03bb24b250\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"e0492c662b67cd82\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"458919243383d371\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"a74dd1276e954d0c\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"6770d5ec42d5bb7b\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"47b9ccb6922d6267\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"dd5b8d400613391e\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"5a5a72d866efcba1\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"a30bdc5e4a31c707\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"5ee45c3969c7f149\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"307f91218dca64d3\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"e3ca1c01462053d9\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"4bd63af67d4c048b\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"c73a426a38c8fdd0\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"899dd33c4803056d\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"1e09d4efb1aa477c\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"e577bf4dd5bc9882\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"f3093526840671e9\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"81d005c5455ab6cf\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"596a3c52cfb457e0\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"89d585ee9adc0517\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"f0642867e4a8a3dc\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"997c33c126a66233\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"0a05a3b4dbdea9ba\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"4d0243df3dc1ec5f\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"aa0c041a9e77d821\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"3f8f251e2409ba78\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"c5b4611c59af872f\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"bee4a53161088943\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"bfb0ebefd8d6620d\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"c49648ae9800fd47\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"3faf025c8f4a138d\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"2a40658d3ec29edf\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"d107f513345eaa3d\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"badcd403a00f5496\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"32a6b0b9a8bcac91\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"7887c0317e1f8b90\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"ce63b49c6d64341c\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"2be6b6dc4c4e8dca\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"393a9beb1583ccdb\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"d0cf68f7732557fc\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"e83a7d794d137a36\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"3da4bd6ec4867121\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"378ae74960b54a6d\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"12a03ceb39724337\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"4c9e1f90eedacae8\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"900bb61358dca05c\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"ed0d241dc2ab40b2\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"7f360e01451da638\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"a99f3eedc9d9d1d5\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"8d22f1aa4fd01b71\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"978b0c903ace88dd\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"a77fbf02e7d415e7\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"a716190f8306bf8f\",\"/knowledge-medium/src/components/ui/button.js\":\"e7300ae17bd916b8\",\"/knowledge-medium/src/components/ui/card.js\":\"d400a96f0edcc4e8\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"4f8dcfdb9e80136e\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"5aaece3e18c3c3b8\",\"/knowledge-medium/src/components/ui/command.js\":\"fbc31d7072149a11\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"72b6bffa8049a445\",\"/knowledge-medium/src/components/ui/dialog.js\":\"08de87c9f0898c35\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"d18bee0a7883a572\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"caea6a2905c4bacd\",\"/knowledge-medium/src/components/ui/index.js\":\"d26ee011369e727b\",\"/knowledge-medium/src/components/ui/input.js\":\"aa96845854cb9257\",\"/knowledge-medium/src/components/ui/kbd.js\":\"26c30cef2b486ecc\",\"/knowledge-medium/src/components/ui/label.js\":\"1aa620ebc9351457\",\"/knowledge-medium/src/components/ui/textarea.js\":\"97bc525380196369\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"c4cb60fcd22ebf7c\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"0526c217afb36d32\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"872230c1d3d24fc4\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"a29c0f92e6437d31\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"e2c475414a7ffc0a\",\"/knowledge-medium/src/components/util/error.js\":\"3954851f4fd2273f\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"b9d4b8869a1bcc9e\",\"/knowledge-medium/src/components/util/suspense.js\":\"e2eef3eb63b2c8c2\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"7d4a91c165a6a843\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"1917d6b62917068b\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"430e8767135aada7\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"121c72cfa4cdc187\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"c18c754ee84a38de\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"fe57eb45d4275e30\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"1dae6176334ac50a\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"b49839717c6f7ac8\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"7a0efdcd5649cd5c\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"2c89c2f28bf23da7\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"44f6c8ec0181c1d2\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"b92dde78cfc9c61a\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"6b7a5f11072b1fc8\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"3f6f379b912b45bd\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"f1f416cb671c2357\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"c04c2548f7f8e7bc\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"7269fd7fd0cc4a4c\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"ac290e7e7f2ab393\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"593a3c8194c565a4\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"4ca8a6763c51fbb2\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"ae7799f6843cb8b0\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"10781220ed4c9f7c\",\"/knowledge-medium/src/context/block.js\":\"0917b331cda87263\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"35c4f0790a85c008\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"634267181a30e70d\",\"/knowledge-medium/src/context/repo.js\":\"e209b51a7d0099c6\",\"/knowledge-medium/src/data/aliasClaim.js\":\"499390684496573c\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"1a087451c3d87ac6\",\"/knowledge-medium/src/data/api/blockData.js\":\"05f3b81f9d4f6f35\",\"/knowledge-medium/src/data/api/blockType.js\":\"9c75469b9a0266ce\",\"/knowledge-medium/src/data/api/changeScope.js\":\"9aaaa2dd5041e157\",\"/knowledge-medium/src/data/api/codecs.js\":\"513b5bc5dc12068a\",\"/knowledge-medium/src/data/api/derivedData.js\":\"357770f99d8ea1f3\",\"/knowledge-medium/src/data/api/errors.js\":\"a1557c8f5e83a6da\",\"/knowledge-medium/src/data/api/events.js\":\"169605ae5002e28d\",\"/knowledge-medium/src/data/api/handle.js\":\"c9a4ab9ea6fc8b1e\",\"/knowledge-medium/src/data/api/index.js\":\"2214acad22555165\",\"/knowledge-medium/src/data/api/mutator.js\":\"55bb147b750b9cf5\",\"/knowledge-medium/src/data/api/processor.js\":\"eb384fdd0f7c7ed7\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"f5b6f4d9cb5623fe\",\"/knowledge-medium/src/data/api/query.js\":\"73210dc17a4a05f4\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"c221158eec4db4cd\",\"/knowledge-medium/src/data/api/schema.js\":\"c9a4ab9ea6fc8b1e\",\"/knowledge-medium/src/data/api/tx.js\":\"c9a4ab9ea6fc8b1e\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"09107d1b713411ad\",\"/knowledge-medium/src/data/api/user.js\":\"d46126f4a2b47b15\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"4e18be1cc3f6b300\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"67d38d16448d1e29\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"0c5763a9626cb85a\",\"/knowledge-medium/src/data/block.js\":\"3415af63343a4281\",\"/knowledge-medium/src/data/blockCache.js\":\"f45a10fd9d2b14c4\",\"/knowledge-medium/src/data/blockId.js\":\"86bc4caaa9072c1a\",\"/knowledge-medium/src/data/blockLiveness.js\":\"330a79b124a83194\",\"/knowledge-medium/src/data/blockMerge.js\":\"09800c7210bd990e\",\"/knowledge-medium/src/data/blockSchema.js\":\"876cd19d43f1e795\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"da0a180392ee8bd3\",\"/knowledge-medium/src/data/blockTypes.js\":\"6b2ab43703fcc2e5\",\"/knowledge-medium/src/data/clientContext.js\":\"2297553316be2dd8\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"4486b7fb7b6b5d71\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"dfab93f5b13ff521\",\"/knowledge-medium/src/data/derivedIds.js\":\"d2c8e3bf6efa8c2f\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"4e6c0304d4fc767c\",\"/knowledge-medium/src/data/facetBridge.js\":\"f7d7a687832537e6\",\"/knowledge-medium/src/data/facets.js\":\"2e5e6553a61222a8\",\"/knowledge-medium/src/data/globalState.js\":\"e0b964d507bb9ec1\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"e72429dbdf4bd721\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"d648ced1c3151c91\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"653f42e7cd672147\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"5958690651d15c73\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"a337fd488a27c6a0\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"b066f696a6659637\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"b90424fc2b06a6a0\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"88ff99cd5f6b9b3c\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"f5b05f927d2619a3\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"669ab2f4b987ba7c\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"c26f2013c7d67efe\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"0ad1587f798be2e2\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"e777400f47278a33\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"88ed99afa133856c\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"0e053ef021ec3c2b\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"b7ab05dcdc34f556\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"622118939d9cba51\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"31d73b5037d7775e\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"4680e927f26fe837\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"68333622de831b9e\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"75f3ee4e60e583f9\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"8bd865219575f265\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"23b04a1caa38720e\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"7bcfcc4e9c777d91\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"8514a58fb933db8c\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"29b5775157449a93\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"9fe530c8f13802fd\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"006435b9bd7e3353\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"637d063614482443\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"b5e36b9f511336a5\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"773d03434125f4ac\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"829492ce8c78fd4f\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"97d1cb1eae7cad36\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"32baf71773a2d620\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"c2ca55f48c58c858\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"d5f4646b8e471976\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"568d7035464b423c\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"85e96806db8d4ae1\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"581442d0f8658471\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"537a9564b134004a\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"3f33267d7c99aae2\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"f3c1505a0b2d77d7\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"2eb5f6b8689499ab\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"920aa3f7f71d4496\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"9af944714c9efd4f\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"1fe625a4ebd13980\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"e5131f3634b7a051\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"8b982ad958f1cd06\",\"/knowledge-medium/src/data/invalidation.js\":\"29f816281b4ca08a\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"9240117c03aa32a4\",\"/knowledge-medium/src/data/kernelPage.js\":\"1701d5dfaacefe25\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"e0a1c9af2d9cb2b4\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"d7c1a12a32273faf\",\"/knowledge-medium/src/data/localDbStorage.js\":\"5cf4b82f7c20fbdf\",\"/knowledge-medium/src/data/localDbVfs.js\":\"5ed6bf4f180808c1\",\"/knowledge-medium/src/data/localSchema.js\":\"7a9fbb5f022241c1\",\"/knowledge-medium/src/data/maintenance.js\":\"e18407ecc0a5fa22\",\"/knowledge-medium/src/data/mergeProperties.js\":\"b147f6d2aac173a4\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"424d7b5edd7e65b6\",\"/knowledge-medium/src/data/migrationsPage.js\":\"897da1dc4506a515\",\"/knowledge-medium/src/data/mutators.js\":\"548a20bd4b8b1600\",\"/knowledge-medium/src/data/orderKey.js\":\"0edb3e2abcfad0b9\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"66cba2da23936725\",\"/knowledge-medium/src/data/outlineSurface.js\":\"c5ee6cdf93426748\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"6b6097506fa9f876\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"3103743f3c2f13a6\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"252ad6f736aa7b9f\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"20aa45f550d9100b\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"9ad1a746d9e9ba7b\",\"/knowledge-medium/src/data/properties.js\":\"2d3951e776b97cb4\",\"/knowledge-medium/src/data/propertiesPage.js\":\"bfb12e82e8a2a7f6\",\"/knowledge-medium/src/data/propertyChildren.js\":\"bef4273bb5327266\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"36418af9dfc48ab9\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"627d1f2b683eb9bf\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"c337093c01a89563\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"52129ada0ecd7a8c\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"173d933ff7736a59\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"0fc46d8c5c676545\",\"/knowledge-medium/src/data/propertySeeds.js\":\"f52438b4f2a1a612\",\"/knowledge-medium/src/data/recentsPage.js\":\"d57f10c7b12969a9\",\"/knowledge-medium/src/data/referenceBlock.js\":\"24a7d33f7e555ed1\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"b204faafa5cfbe53\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"e1a6c57e70ae57b4\",\"/knowledge-medium/src/data/repo.js\":\"ae4fe4947de7f6c1\",\"/knowledge-medium/src/data/repoProvider.js\":\"978fa86f34adb2cf\",\"/knowledge-medium/src/data/rowProperty.js\":\"625e98609c52ef34\",\"/knowledge-medium/src/data/searchFilter.js\":\"3a27b40c6c858717\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"dc8e570800ea46d7\",\"/knowledge-medium/src/data/stateBlocks.js\":\"098dfabf85b2e4ee\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"3c8e2b25e7f46c00\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"9b630f69f23cc58b\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"b5ebe3fed3be84a6\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"2d337390e661fadf\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"7927fbf75dbc274c\",\"/knowledge-medium/src/data/targets.js\":\"51102d5584cfef8a\",\"/knowledge-medium/src/data/typeColors.js\":\"4b2ab62f8195af16\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"6a56a4ee7c05dc95\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"36cf6c96d7d3b899\",\"/knowledge-medium/src/data/typeExtraction.js\":\"3e51adccccca3c07\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"9332826b82df8104\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"7fbda6b42b73d3a0\",\"/knowledge-medium/src/data/typeSeeds.js\":\"a7ae7192dc26acfc\",\"/knowledge-medium/src/data/typeTagger.js\":\"7472b571c0c24f37\",\"/knowledge-medium/src/data/typedRecords.js\":\"4c3f1e25665f00f9\",\"/knowledge-medium/src/data/typesPage.js\":\"948c7648d50ea9c9\",\"/knowledge-medium/src/data/userPrefs.js\":\"9b52a73383a8403a\",\"/knowledge-medium/src/data/userSchemasService.js\":\"e72c6862a03b4995\",\"/knowledge-medium/src/data/userTypesService.js\":\"f46778645aab52d9\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"6f35245d47bdcd82\",\"/knowledge-medium/src/data/visibleChildren.js\":\"c8d292bdafb48880\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"6880d92c6aed1413\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"acd3fbac7c726918\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"1d37e7760e9c75d6\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"e08a81793a1b0876\",\"/knowledge-medium/src/data/workspaces.js\":\"757640208c304112\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"059cd3ff75a3ac7c\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"798ae0d1b7ef01a0\",\"/knowledge-medium/src/editor/atTrigger.js\":\"322af32a52c3ea80\",\"/knowledge-medium/src/editor/autocomplete.js\":\"dcc9f4e66e12d96c\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"389f32f70f25ee37\",\"/knowledge-medium/src/editor/contentFlush.js\":\"6043feb50017f498\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"f606f5ab450914cd\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"63e7c1e4d63037d9\",\"/knowledge-medium/src/editor/insertImage.js\":\"257baf911acd7162\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"cb5a45e7b46f32af\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"c0317e890e327b98\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"3d6c98a67ed35ac7\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"77a6693c08974772\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"ab04389bc0a890c9\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"9ffc43fb6e702118\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"a0523af59f510585\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"6537e9a7490f85e5\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"60cface81a866a60\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"e8b6180d7f9ddbfd\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"a66d7a108e31ca74\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"c094e7d7c55ecb6d\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"1e24ecdea41502b5\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"f549531a427f533c\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"da2e143ed8f74e32\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"afbc70b47ea9cbc4\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"159d34d0f1a459e6\",\"/knowledge-medium/src/extensions/core.js\":\"aec0d21e11bbdec3\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"1d22e7720564bfd9\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"600336ff541e3330\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"523b840b89136b76\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"5093669ce3142e4f\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"70e2a772e9ade356\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"45a741b1e24007ac\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"fffab5909b37bb80\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"194a59b91cfa0acc\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"e7dcbf698f83d60f\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"ff326613292ad184\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"ce0456c8f0fde717\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"cdc6f1aea103ca72\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"a812439af6d511e4\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"3d05d7ce71a585f3\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"235dc66a28f06bd4\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"af880a1f756060b5\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"36b44e66cbce6730\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"5b5c631c692b783b\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"a55f4e5e6b8ff832\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"46bc0725b32f675f\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"9da6837942b8cf98\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"6b1d02a9c59ee5e3\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"34ba5f6c1ab52e12\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"19a86b04bb163299\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"35884082c1aeeee4\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"cfcefbe2c44977b6\",\"/knowledge-medium/src/facets/facet.js\":\"53d0836f540486ce\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"c3e90af203f4dccd\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"c3c569bc15eaecdb\",\"/knowledge-medium/src/facets/togglable.js\":\"177d7e2818913f09\",\"/knowledge-medium/src/facets/variantFacet.js\":\"50f7ced9a7ced185\",\"/knowledge-medium/src/facets/verbFacet.js\":\"79ef62fb1f4f547d\",\"/knowledge-medium/src/hooks/block.js\":\"87a70155382fb9c4\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"02cc7bd0a1d74268\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"1df623fd27242eb1\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"d1c4420a143d419f\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"39cd70f7efbeb39b\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"b31937ffaacab804\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"9f2da8f2b0c5378f\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"dc7e3f8782378c56\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"24fcfc8cc1d72cc1\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"bfb5c2a4b214405e\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"4f27d1f4fead41cf\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"6852138860e604ec\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"13d13e6185719ee0\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"d3d6fa22d93da8c3\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"6d1870868939485a\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"557d1bde8404b941\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"7bba2fbe5b68c970\",\"/knowledge-medium/src/lib/utils.js\":\"139774040a7c2179\",\"/knowledge-medium/src/main.js\":\"34c34267f0bb34ee\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"0f6a77a61768214a\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"ef3c870f621781b9\",\"/knowledge-medium/src/markdown/context.js\":\"b13c07dbea2d9b26\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"bf55559eba11e730\",\"/knowledge-medium/src/markdown/extensions.js\":\"f369824ecedb38b0\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"13e9ce087a7708c5\",\"/knowledge-medium/src/minimal-editor.js\":\"4e57d631eb2cece9\",\"/knowledge-medium/src/paste/armedCut.js\":\"aebd914f337e4c68\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"ad6fc1d5f3339002\",\"/knowledge-medium/src/paste/clipboard.js\":\"2c64fbe4cf9c1157\",\"/knowledge-medium/src/paste/decision.js\":\"15f0193b42a18a07\",\"/knowledge-medium/src/paste/operations.js\":\"2a5c88d5d3b2d797\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"273a1c10c8d71dd5\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"6263f307eb443750\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"bfe08142436688f8\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"9aa4fb41cd679254\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"d0caf55cd5e76741\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"750f5d51612eb182\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"7d7d2107248f983d\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"1de16fda037e46cc\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"9343b2a6b3a78454\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"3541eed0dfa7b4ec\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"15490b9f7e3e3936\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"0960e10106d7f836\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"2e905e568dc1e5e0\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"825b9bf99486dd75\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"298383922baa3b4b\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"cd967789195c8c63\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"7c31d02b0e54b090\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"3aea71321bba7ce3\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"8d9e0a4681a71099\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"3550c9a73f170bb8\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"cf898880e23dc360\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"27f83f6f115e6b1e\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"ea74a9cff66ddfb3\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"777e74462580c235\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"c1aad801225ab6f5\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"999981711e353183\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"c8e33dbbb10be559\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"b5d979d6fe99f325\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"ab551034a48a970e\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"a2defb249888768f\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"c977662ce8ed331d\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"18804f0e4c82a6dc\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"06b96534cb4a2222\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"eac4a5707ea73697\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"bf018f5a78bd5564\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"6b3a1ef72beffc4b\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"3be2a21cdc76fae2\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"1dc040305285211c\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"5f373f4f174342e4\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"455dd0ae22468c4e\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"a7759f15c0e338c4\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"50d9b79354811e2c\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"cce3ae77cc10bde2\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"5580d76101956fbb\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"88d464eda1bbbd0d\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"fe3797a088f97e72\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"7122ca0d38edcd9e\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"394e6e5e007d4d1c\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"8d1782a30fc3863c\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"99b0905609f8ce60\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"01e36194ba64d4a2\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"cbacb677d5bd4ba8\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"29cfa6203ff41696\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"cc689592dd31c885\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"597da186aa27684f\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"418d4112f9e3b894\",\"/knowledge-medium/src/plugins/alias/index.js\":\"4f435e4247aef5b2\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"d831d79e9689953b\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"02f5ad9f88cd8adf\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"87347e257877bc21\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"b32f221d0e4ca8d8\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"059e7aaf4e727146\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"54110393935d0ec1\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"f955031e45ec0379\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"7b057a1b90c8dbc7\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"1427697112bccb85\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"3740cbed0d66c835\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"9a1593bc68daa8e1\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"5eb9768a30a26c03\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"3225170a0cd02be9\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"589fb1e0389dace8\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"44678930f4f26453\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"79cf1c74eab95d73\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"0ea84b7edb664389\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"01cc6b4b8f67946a\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"6bb940e105261cd1\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"cd51d47f8c6b32a2\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"87cfda9aa0143fc1\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"07518da1bebe16d7\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"364b163e476979be\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"e3ea8eb742699f17\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"88ba4255843f4fce\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"485a5661b23d7d6f\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"384e4853ea8a49a2\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"bc3bfcb3cbe3b344\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"7b35cf0c187c884d\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"3ee90428d6dcb374\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"7f8f7906d98ceb20\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"21640c0b43972ba2\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"542f9965405075d6\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"754103a6d1389adb\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"befa74dd6014966d\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"f48ad5623429873c\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"c828a8d5a5b16191\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"f8cbf71b363bff99\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"3184cbf5955eac43\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"4af067fe4d7b2b2f\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"9fa71126359624e7\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"53bf82f984313a2d\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"9f440bd458b9ca73\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"8e28e05e2bd8074e\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"adf24aa42177ee48\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"42bd95f73b8c5658\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"d8a19fe8f32e53a0\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"ba1c5b86b0f7ce96\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"a31aa4e87d85c9ca\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"496c74c470affa5d\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"5b62002ebf5c7e59\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"810003ac7ce93d58\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"3a2bb32ad0f8f635\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"1078f432946d4b52\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"9a2846f8d3e210d5\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"1309c23feab2db3c\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"7d46034d06e0e981\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"5a4d8a08cd62978c\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"a288076c85be2d5b\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"f00713c3c9789864\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"e9bbd47698cbd1b0\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"c9a9cf102871c3e2\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"b37a589b60b8e7e9\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"b00bdf275acd2d80\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"95df6b790cdaed93\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"ffeb55b19c869009\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"569e2d48ae1235cd\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"eaf9a9b6b6c00a09\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"112682abb437b3a2\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"d69cbf43a03b275b\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"6be601d92d78929a\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"176c3b0080dc2f9d\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"5dc7d88e95b958ba\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"04b47d19a3ba81ec\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"49fb0c8b1efa7461\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"5f765d18e3aefc47\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"be1c00d1760735b9\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"1aa07070f5a07c7a\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"f31acfa7aa358f7a\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"07127fd58eae5039\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"871e091710f26c40\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"23fff17a64ec7e29\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"3476a3061e0d3458\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"a5ff338f1d130656\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"fd83dd1a40fc7e7e\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"ec92038da8adfb83\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"84f23026a8e75606\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"2dbe70916316b517\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"7f11b6d442a71d3e\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"8aa41665b3fe4a7f\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"c64be45f529a165b\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"6292e67dc1dd94f9\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"f105f1cac1ed3f45\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"1a74b1d4b939aef6\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"3c1fa88353a28b45\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"408a76ea920b2555\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"22248f8901bf05b1\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"485ff4b6c7f5ad10\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"81738dbbd4226969\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"53db096a93fb808c\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"b0bd58750f1d1f7f\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"fa4e845274df5c26\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"ad819c21817b87e4\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"2682d8f423560bf1\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"5105198c1b88c68a\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"6fc4dde80a36908d\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"d62ca8ed4a954cdf\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"aabb8c0018ac5b57\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"fed0addd78cb7d49\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"89f961dbeba500d7\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"af301d5c3ee5cb11\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"aaf34941181783de\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"f46a2611a7e95b90\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"ae95c602d7112d27\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"50419c6c98e434ef\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"85bad135e27e7e37\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"446377422f815e5f\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"a77dd82e73a0b9df\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"c9785b0e2cf637fd\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"8cb8e0bb2beef91a\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"56754d34cb273b5c\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"986f936c5e1e0b50\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"442434224e98bedb\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"48d1ad8c6f6fc1d9\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"6b97b2f1f52a7378\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"10914668a2fa9c68\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"c83fd53eb5fad5b7\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"9ba5d4e30327d15f\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"3b233da5c44879ff\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"75612e4690db9203\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"d28c10b588b4f6d3\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"50e95a205c7d9e59\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"2ddf74d00b5fabbe\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"4f3c22a40cc8e23c\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"251bdb0d8d25aca8\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"0117b144ad4411e2\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"a541bd22d90c0e46\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"fef269cd2a511f4f\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"6feb2f8b88d9d83d\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"0f4605940b66815c\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"1916e3affbca9b65\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"3b5052e98875ec76\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"fb91c339c1fc485b\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"3fb813cff8bda640\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"c0fadbf306e68327\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"95c6dc7354b6904f\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"0193eeee5cb137b0\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"89f988daa4d7c9dd\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"a00dec6fcb926fa4\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"181bac675d7e8a45\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"98dc5b68e7953101\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"31c328322dfd2aa2\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"895066415deda48c\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"61c57570c14dc9bb\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"ef1d861295bde971\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"40374706a967e6f0\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"624d122e650ea235\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"9650e3f396282b58\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"777f586ff1cfadbe\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"d4de1297f0f65eb6\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"794d8cf0e2780164\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"0a2e9e0535661d1b\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"28f0de55c4676603\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"e1caa14466c5b048\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"ec5a893fca8982d3\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"536d4c54fb2b63ac\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"441dbb52306de265\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"7e604d766bc8d82c\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"d79cbb2701a31bce\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"3688511c48faa9f4\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"16c9727fc61dee18\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"9d9f51af8beb4bd0\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"6e3810627112b5f2\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"034c3217f525e3a3\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"ab69ad00eae01ee4\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"109cd67d570a4807\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"ef0b02077909c44a\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"e8a7f9f24fb164ce\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"547c704e92dbf939\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"3c4a6df9ebb6d755\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"896666924e71630f\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"e82a1be7629b9858\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"08d8cbd716a87f49\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"53ced5e9cd5555c8\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"237358d3bd183705\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"669fc24ba8144042\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"8ed36e9fede5b88d\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"b8dabdeedfd19f36\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"b48aadc4b8849471\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"61a0d42cf8081794\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"86e322d56584afcc\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"66eb1a4a3eabe16a\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"16931fe9dd60355e\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"4c7220ce121e7412\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"c85a1a52c9727d6f\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"dfbfcd5438f81ed5\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"abf52da19977038f\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"ac30c02b39f2ea02\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"56c3594272536a25\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"9839c48ea37e7b3d\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"1726f27a7409adbe\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"e32dce77ff964e3b\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"bf2b9acfef9a5857\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"55d18ac510e9774a\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"913736ec14621e22\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"13fb8eb8d491b40b\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"25ee218de7ed7220\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"225881bb81c0109f\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"6e454441bdf84c59\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"a6eca37eb87dbd0e\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"4b704128cfc1e2a1\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"7fcc5397f21cb32f\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"68c77894a58b5c00\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"cc020d80f73d3241\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"9fb02d403b0d13e8\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"52f7c60baeaa66a1\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"3df843c8b898e033\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"be8241ae51ed922f\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"3a591eeb4efd1043\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"f4138bbbbfc8d14a\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"faf2228b8b25d9d9\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"f4299f1dfd4b7246\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"6689726ad0d212a2\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"6ee72e285cf303c6\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"87478c7434557701\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"3e7a558e915034d8\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"1d385f9ce3169d94\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"a8e177a5ed92c9c2\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"4bfefd5c9c3dfb06\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"9afd8145a460f263\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"b405355d8919befb\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"6bafdc91eccf625c\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"9bf97f9cdc675315\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"92aa9158b8a378fe\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"de12ed155f2c2d2c\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"e28f116c6c04b288\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"186383e2abd0d44d\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"eb3055cc1738411e\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"0b549f2488a95939\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"ecfc78d585d50671\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"4a22b9e43892c9a1\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"a67e05a649f4ae76\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"a32aae24cee65e05\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"76ccfaab89c7e627\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"7aa21c58c04063a9\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"cb0179d2bd33be77\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"9bb78d7cfcbc26a0\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"d5ffdb108626013c\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"9e96b750899dd417\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"2fc14e7acaa82498\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"1d26fa6968d755fb\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"ea2d7c6ccbe76ac1\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"be502ca4e2318f4e\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"838756405d04e147\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"4dcc929de6207ab6\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"fc831d693c3803e4\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"4e9928e7ed5d7bbd\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"16953dc9365414ca\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"5a34cbd46e4975ec\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"41c78f78d01de60d\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"c075cc5c1e6178c9\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"cf86cb4800e2b0ef\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"fd473510ca8c896e\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"8bd4ce9df5296b60\",\"/knowledge-medium/src/plugins/geo/index.js\":\"f84f39888d8958e0\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"2342ca564ddc8074\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"1e610e95cef1f231\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"c9d9f591d7fbae05\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"3fc425e9bb72cf37\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"feec24aa7519379f\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"c7757e9d5129c0cf\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"18a692dcbea24af6\",\"/knowledge-medium/src/plugins/geo/query.js\":\"b96b0d5839462959\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"d59c22434d33d090\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"cf7309d68ae7896b\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"9c6079349f3a37eb\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"4c48c3a5d2581521\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"3946082cf391dbb3\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"f51b8c7eb6ad0855\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"6b81865797febfb4\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"be9f7da4b6d3b315\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"4bd1d229a707cc2a\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"b43fd5318229ae70\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"a346e6845580d37d\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"73ac33bc2d8b04ab\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"d2b0c084e2fb4e1d\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"3da8e6cea89e055b\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"46df74686369e646\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"4383f0020e092e39\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"7a3fe80e6e00fa2c\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"61342c9c6f7d57f7\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"0b3895c6ab5dfcb6\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"4c6aa2c34e22e84a\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"e30d01f9434380ad\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"a79fdb5c4bca173f\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"077de9622fe238a7\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"d515e804f8b9dcb2\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"b8c20bd586ac3fd8\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"6b50aa7da6c2eda1\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"5035c9122064daf2\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"107f7b1a9dcb1c42\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"dc2388ed6eb0528a\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"77746a8b63bca280\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"485af8a6757adb86\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"0c43c8e9cbd8a7ab\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"4b0009e93dc83158\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"30456fed444f2408\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"1c90cde3024d4250\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"c5720253e0400d2d\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"d70d6f7fca09036c\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"7d6b7831eef074e9\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"be08d9d8d602651c\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"099abaa5043cfb7f\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"8f4f425f8be38e70\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"23ba6fa43ac4a332\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"e7a1378631dbb54a\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"07d7f31e586a2eb5\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"90f433733789640b\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"dbcaf173e2acfc2c\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"66bdb5f2e4f076b3\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"b412f88655427893\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"167cf90dc2620f4b\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"5750181e8943a9c9\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"4e56a552113adc39\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"28e0202e730e79db\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"c8ae47e4ae14119b\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"cbe254f91c06a86a\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"2a6a7a743e9ed67b\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"e52d2445f724e56f\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"dc74fbc2d2591c37\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"0c899c8044109f78\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"697385dfbe44f4f6\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"b339f74d7e14f134\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"e4c58d5959a62592\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"1c53de7c15a7687c\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"a98388e86d9d686d\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"7cf3ea53567ecd51\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"03377d11dca2913a\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"ab88de5bdd6eb593\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"7046dfd6b0427c50\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"50d34172d6d2a0c2\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"718a622e2018116c\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"c6fa73c4db608cbe\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"703a69d25c6a12e2\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"eb15d96291f6e95e\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"cef57ec7ca5d0942\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"d62d0fb4729311ea\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"c73a93d905af27a2\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"8c65438688eea233\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"2947c9e6f71f3c6c\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"1d85f298a9e9a416\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"f82bda6554d0b9b9\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"9eadb7ce7c20ddcf\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"bac615042432d21a\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"3be8bad4aa0f9f5d\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"5625613e35c76155\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"ec970d3cf4e27525\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"2b1c7ae92d03453c\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"e064355b4fcef6c2\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"68d59fbd144aa6bb\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"09525f620d67e9ee\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"2bd37d80f5715820\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"d2bb88c527631474\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"66d5da3271c61a36\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"0ee3886752b13b4c\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"a7220eaccc6eebe8\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"32b976594de47655\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"2dcb57140a903633\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"d4bbcceb9dbedef9\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"c3caf0e85da84858\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"5478f226fed6ca78\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"39b85904ebb23729\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"788b0d6b1db59cc8\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"06f3a63275d889a1\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"0f0aa4afe01a446c\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"97e30c12041eb2f5\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"284381fc985690cf\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"bf1f3381081a0ebe\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"7f36dad48162827d\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"4a946e590d5cbd09\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"6a7fc63928d1211e\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"93f789bc4bc1fdc7\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"b1feff6dd664849d\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"42f6b9573368f11c\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"cd969f13bca20413\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"afeb7b3827d3cc04\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"c2511cbca5d0e07e\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"2a14deadecee3605\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"13ccdc25e91f785c\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"b3f4767f01e0292e\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"ec94db5852e5bade\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"1966e3f8aab3245a\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"5dc048cd2110acf2\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"4d9c435078cf2662\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"fc6fe213241b7902\",\"/knowledge-medium/src/plugins/recents/index.js\":\"1583dfc61459d4df\",\"/knowledge-medium/src/plugins/recents/target.js\":\"d19b8606151aaa2f\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"cbf08cb97120459f\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"6972650dc7e22afa\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"6c2b7afe3d770c69\",\"/knowledge-medium/src/plugins/references/index.js\":\"5bc4f4686110d8cc\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"998679bd2d47c1a1\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"283e61b4a9124c9c\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"0df9af7bfc65ea36\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"c865910555fd41c6\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"7425c99795ca0726\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"05820d3687879b53\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"0314674e3166efc4\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"ac5a46f34116903c\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"7ba5382db39d011b\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"f4a68b909bf4a9f9\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"a787a07764cb5fcb\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"4384ba35502223cc\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"b8ca0d0286f1517d\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"1a4e85c21962fb4f\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"7c57bc197df21e89\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"194968691fd44fdd\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"67c89d9841bf268c\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"321f4ec16fc441dc\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"7fdb9a1460cdf3d4\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"0cbb5b1f6dfb9e9f\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"18b4bab4d4c19ea4\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"a49d4cccbb307f00\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"fa0db63651723e9e\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"6c32662168ebbff4\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"637f10da936b558c\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"44d35ee8195232f9\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"43e684d3bd1d0dbb\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"4bd2bc127b6cb70a\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"348ae5c77bf2c051\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"c68db50afb95f876\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"45725cfd8dcee62a\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"808c939b226abd95\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"d4f37fce83d9f79b\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"56ce629358ddedc8\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"52dbf8c530bc93cd\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"a7a3cc51537afc4a\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"fb390b3d54d19d82\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"dd7702cb6704a6c6\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"495f6a1f0d7b1583\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"715a2f52c27e0c8d\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"a70bd142418d5284\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"5a3a2c64471aebaa\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"8253b6e180e77802\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"774169fcd2d91e35\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"aa57339eee6c6d66\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"74fdb23076984b01\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"61561775c718e23d\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"791fd8aa73fcc628\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"7f7f964df3717468\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"39998ca42781da0d\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"421d8816a3c1545e\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"8b3473e8683b9ca3\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"01cccf191312a77c\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"b4dbbed3910107b9\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"3cdcdb3dd62bea11\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"d288650eac4e35d0\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"331a14deb6dad31e\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"05d895797f45522b\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"e81c67b56c2a675f\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"c0f93bbcece36458\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"9da49af73695dcac\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"a8a732b28ec8e3ac\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"ee78c078fb844dee\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"6e8011f2dba24a6d\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"c3c159f9b31ebbf4\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"58dedcd84496276b\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"79bb608c8bc315df\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"08e795cd23ef2071\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"06ab33e21886a6b8\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"6e91f6031ee374af\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"017163ad6af1980e\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"1586b68d55a1f750\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"09ce07345200d424\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"bf2f32490bcc0efe\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"9e5530e11347c4f7\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"6739d74c90950381\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"03b7cb577ca1530a\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"a82486a6870a11ad\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"6eba6fa439848f3c\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"5ceed307c311a15e\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"015353b841edf509\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"5d284d978d4e3239\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"0c095dd809379c38\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"e9a2bd2801284965\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"41a92aad154fb7aa\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"e284d255dc8f8ed2\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"7f6a0af1ac672e72\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"383064c46a91904e\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"3c3043f3d97fc031\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"5a2ddbe144d11edb\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"d439e9e5bb0de725\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"af3f7e0116f83c44\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"de6cc4012507d603\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"0202906273451e65\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"3f432bf53c52a5a4\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"10a759d9b3711d1b\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"556b29f981a17639\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"32e897d37f491761\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"c5d31485a6537f61\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"b92ee28c6bca6d40\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"fb57eaef1335e743\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"2410c1c95de116a0\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"deec20ed70ce1417\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"512703f26aebb45a\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"e149ea230fd3b12e\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"f321621b452524c2\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"88b2f94edcd42748\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"96af8e7dc6c6484c\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"0e2905d09fa8103b\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"e6cbb67448994df2\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"063bf25ed5bd6276\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"55afbf6fbedd969a\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"f47af9d9bc378e3f\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"550d164fb22f517d\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"c08c5c121908f415\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"1ad79aa79794ed55\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"eee8c39a8f47c860\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"2337ca39157c7055\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"d43bf44a012facdf\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"4281b4e6bae6cc06\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"c4701b743ec7433d\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"a2ac95929d177282\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"9a0594a7863b94c6\",\"/knowledge-medium/src/plugins/tables/index.js\":\"2ed8322edc100eff\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"34c10a28633d5b51\",\"/knowledge-medium/src/plugins/tables/model.js\":\"b5060d5d534d76b5\",\"/knowledge-medium/src/plugins/tables/navigation.js\":\"eee22392fe44ae2a\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"a4c0486c75da9383\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"66f40d7498d4549d\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"5340232da5fca1cb\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"b595260e828b3aa1\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"29720c343d0228d6\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"afa31f1961ec6d5c\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"2d9948504f4b03dc\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"4a9fc529c8acfe92\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"ad25d1277bfd48f6\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"39476b47894a1042\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"f678c985f73080cf\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"d27e5806f256b951\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"3fed72130c776df2\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"903f9455b2e60ca0\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"aaa9b8c9d69dd374\",\"/knowledge-medium/src/plugins/todo/index.js\":\"14e315cec32db22f\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"13154df0819e44d6\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"4733a1b5abcbe7c0\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"7d3d20becf1d1592\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"1ed75f023990cea6\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"3450f90bfbaef5e1\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"92a4faf4d9a83091\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"d308eaac201fa81e\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"0a4f8cdc16909a4b\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"9d2b0465a19617e9\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"8c2cb16e9b5c4b9b\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"de703c36c18d6b56\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"a710eeee82159eb2\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"b02cd9993d780ff0\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"33e8b4aea13d3923\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"9397680d5f5c84b2\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"9f9d1f65ece94ee6\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"5fec00550e77a59f\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"d45a46f619218992\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"1cbed899d6b6de02\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"f7965e72b6abfae4\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"0b3fee4837622d24\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"83915881cb0b21af\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"82cd2ce3c2ea9d8e\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"337a7894c2ccba7d\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"e4cb3b62c05a227b\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"d6c503edc25401b0\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"62c99012789dc8f4\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"dc53c82bbfe33369\",\"/knowledge-medium/src/registerServiceWorker.js\":\"553a341d5dec146e\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"ad69a39852763441\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"3434c87421d9f80e\",\"/knowledge-medium/src/services/authStorage.js\":\"7a64e775d0680e5e\",\"/knowledge-medium/src/services/powersync.js\":\"a4fd7ff3bcaabe2c\",\"/knowledge-medium/src/services/supabase.js\":\"418e195fde5370c6\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"57ce73c42b39ecdb\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"9b40854554ec7d36\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"630342fbeec905e1\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"149aed891bb8f399\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"095536386ac95142\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"3dcec8ec9a8938e7\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"952b891a88db8a8b\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"a8a1b75e1d29d20d\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"c823aee497fb395a\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"40ea8380dd330fb5\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"5de2eee026db2950\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"b2ebd011d46cb3de\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"abff2ae06b3724ce\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"6af3556152e8d304\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"9f48fca524f39b7d\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"7c69914d390262e0\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"b45f4d5915a4d0b0\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"a50e93868a317fd1\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"60123f9b337ad94f\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"83d89050391cc836\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"b4ce51d747308293\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"3a59127336c86535\",\"/knowledge-medium/src/shortcuts/types.js\":\"0ff326476c0b92bf\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"6941b7462ee86db4\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"9a76d969a51dbb77\",\"/knowledge-medium/src/shortcuts/utils.js\":\"0b01e493e0f0dca3\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"9e5c8b97531c95a4\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"50dbf241abd5bca3\",\"/knowledge-medium/src/sync/byteTransform.js\":\"420b8fea50a8604d\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"c52f18af5d8e6599\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"fec7963d927a7e62\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"5f8639ab9299661e\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"c94177071f1afa18\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"6099a3b9f07e4d4d\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"8abf32b1707ec9c8\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"f9a43858a4f51070\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"82006e3647c2dd9e\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"008302013318b184\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"89f7b34b50d21996\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"3253781be2d699ad\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"2a48a2c99282a98f\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"38296e3208e376ad\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"13ae3771d56383e2\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"c2b0b1e604425ac5\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"0bcf3d8754f4e8a6\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"bc718ed3f1f2a4a7\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"ce7d323b5af07b6e\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"669cf5ca35efee85\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"a5e86e549d0ff3fb\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"774e6480e29d39a0\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"680dabfeba843fe9\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"08bc3a344ad21410\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"4ad0ad3891be6be3\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"4f3cbca18d0c84f5\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"667488cb8b8cada2\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"e27c750350a03469\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"7701ea17784728b6\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"516d3de53f0fb3d8\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"21593aa6162d7c2d\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"b81bdd0cc6af00f4\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"a88696f9bcd59eaa\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"daef897560d562d6\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"fa030b72f4ea8b6b\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"ba302afc26bcab9f\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"41f93fcade6bae24\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"51a63c4d7ab1b36d\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"1b5a25324fda71ea\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"a73b167f58729d30\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"eef6b43251daec43\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"0c8984e0cae1a8a0\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"8a118d7b34413f72\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"15f4dd1b8f6a3ed8\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"382c767443056e70\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"8efae3d9f9f3ff33\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"247721f6e212006a\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"ee691b6ec15f4fb7\",\"/knowledge-medium/src/sync/transform.js\":\"0d6bf5352a930c55\",\"/knowledge-medium/src/themeBootDefaults.js\":\"d0f4e59ae6d470a3\",\"/knowledge-medium/src/types.js\":\"3f2d86723902f7ad\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"9c12943908494541\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"0a9f048dfdf88b51\",\"/knowledge-medium/src/utils/array.js\":\"050d22d0699a63a9\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"9a6492a05eeded30\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"2d1b532ef54bdb86\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"3ace3aff77abd2f7\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"8313d229b5198960\",\"/knowledge-medium/src/utils/callbackSet.js\":\"9203f50d273a54ac\",\"/knowledge-medium/src/utils/clientId.js\":\"4a247456cdea2f59\",\"/knowledge-medium/src/utils/codemirror.js\":\"950b40905c0c7414\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"aea96d54b416c167\",\"/knowledge-medium/src/utils/copy.js\":\"2d28854ee236d15d\",\"/knowledge-medium/src/utils/dailyPage.js\":\"582c9b08e5c154bb\",\"/knowledge-medium/src/utils/dbForensics.js\":\"c01c7f21bc7f758c\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"c8df71c614ed355d\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"8c410dbacaf23c6e\",\"/knowledge-medium/src/utils/dialogs.js\":\"f348051f89fd14c3\",\"/knowledge-medium/src/utils/dom.js\":\"00f2e3542a2a455d\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"c9ae6c767c59a4fb\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"c23f0d701b3a7891\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"37fd0f2375c27bd4\",\"/knowledge-medium/src/utils/flipSlide.js\":\"9813d2be4e0e3b28\",\"/knowledge-medium/src/utils/fnv1a.js\":\"18e352ecac358845\",\"/knowledge-medium/src/utils/formatBytes.js\":\"7d329db04566d8fd\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"32edffcc2e39b7e2\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"278924830fb76e1e\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"489b60e9183c1d11\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"85d095c2dbec5ca1\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"222b75add0213c4c\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"9e6b1590fd3919a8\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"c2173d66f1403e34\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"1496555b243a38a5\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"890ef1b4493711e4\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"d65fb6618eb00baf\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"deca0bc0b773eba8\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"d09fbfe52a7276d0\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"4175bfac5725c91d\",\"/knowledge-medium/src/utils/markdownParser.js\":\"42331a7cf99dc534\",\"/knowledge-medium/src/utils/memoize.js\":\"249ec5502f82f224\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"61183b560a7061c5\",\"/knowledge-medium/src/utils/nameList.js\":\"d38abcc7cce6280a\",\"/knowledge-medium/src/utils/navigation.js\":\"77f39db0411bc90f\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"3e1eff93a9fe3edd\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"2718822822fe1797\",\"/knowledge-medium/src/utils/panelClearance.js\":\"40febf0b3c9b9a20\",\"/knowledge-medium/src/utils/panelHistory.js\":\"fa724729a2082ebd\",\"/knowledge-medium/src/utils/panelLanes.js\":\"c81fe11a66e84216\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"594a01abce115b66\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"e1f32c183e798f68\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"92b5bc23a9362604\",\"/knowledge-medium/src/utils/platform.js\":\"6fe6c585b40b19af\",\"/knowledge-medium/src/utils/pluralize.js\":\"9916021778e34e59\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"dbfb28cb015860f7\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"d976590aac720f09\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"e1731703d9ea83f9\",\"/knowledge-medium/src/utils/react.js\":\"0e935516cbbc93ec\",\"/knowledge-medium/src/utils/relativeDate.js\":\"3ed6a14d78955c54\",\"/knowledge-medium/src/utils/relativeTime.js\":\"9d103c5879fc659b\",\"/knowledge-medium/src/utils/renderScope.js\":\"1424ed95eb4f0be9\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"8dd3c984ed080056\",\"/knowledge-medium/src/utils/routing.js\":\"457509b4086469ae\",\"/knowledge-medium/src/utils/safeMode.js\":\"af40bba3e7fde9e1\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"5c5003e1864a224f\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"b45410bad889e526\",\"/knowledge-medium/src/utils/selection.js\":\"d007097257bd36d3\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"9266f8cdccc031c3\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"8936a61ca374130c\",\"/knowledge-medium/src/utils/state.js\":\"768d4e45ed38539a\",\"/knowledge-medium/src/utils/string.js\":\"8a62c423e32196ad\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"2a920771b4e60ff8\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"f211b2d438e2f414\",\"/knowledge-medium/src/utils/toast.js\":\"997285aecfee37e5\",\"/knowledge-medium/src/utils/toggleStore.js\":\"cf067d33440abb86\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"a077cefd26c5849d\",\"/knowledge-medium/src/utils/userActivity.js\":\"8e1a7926ee8d85fc\",\"/knowledge-medium/src/utils/viewTransition.js\":\"8dba79054a1192ce\",\"/knowledge-medium/src/utils/viewport.js\":\"5e7e11a66d77a438\",\"/knowledge-medium/src/utils/webLock.js\":\"6de4842a4ce38013\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"c4b6738c9f34847c\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"9bc506673aa609a5\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"3b6f69d5e82c91a9\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"98665b0d79341301\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"f4aa6ce15e5d015b\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"999e22ad752bae35\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"014a6f70974cc413\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"4bcda51b65af7c7c\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"48f2f4ee21f46198\",\"/knowledge-medium/src/vendor/react-dom.js\":\"56a62894ee154370\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"e7e0f5ee4d31254f\",\"/knowledge-medium/src/vendor/react.js\":\"3209b7377a90ce05\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
