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
		buildId: "85e6aa041321-186e1ed4",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"d84a9026aa16be6f\",\"/knowledge-medium/index.html\":\"d84a9026aa16be6f\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-DlWD6DWP.js\":\"5f82723e9e7d73cb\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"43f4d20be3e24829\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-CCcQHuUp.js\":\"b4b558736a597606\",\"/knowledge-medium/chunks/FacadeVFS-ByV3DYFm.js\":\"f0b5ad7916795cd8\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-Cl66QJpD.js\":\"573b3aee6f429f67\",\"/knowledge-medium/chunks/MemoryVFS-BsRasKnC.js\":\"ebf422be4b5ff795\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-BYUFmsMX.js\":\"fd51f8eac0afb3ee\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-CPw4Np5C.js\":\"cf9ea95c8c46c580\",\"/knowledge-medium/chunks/Preview-DXtwdLDV.js\":\"e60230876408fe5c\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-CjPB6rsl.js\":\"57f1a8f4ce1993e5\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-D0MqH3yT.js\":\"cf4fa087d3d33361\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-B4Hemuss.js\":\"195538c6fa613177\",\"/knowledge-medium/chunks/react-BDJywt2f.js\":\"cfbf78a8c7935d29\",\"/knowledge-medium/chunks/react-BHbRe8Kv.js\":\"2f1bc9df6b8f5552\",\"/knowledge-medium/chunks/react-CPtgB0Kw.js\":\"7cdf43ecffef0d53\",\"/knowledge-medium/chunks/react-CY8k98PD.js\":\"3d25da429dd69fe4\",\"/knowledge-medium/chunks/react-CoRf3psa.js\":\"4b38c64e45738af8\",\"/knowledge-medium/chunks/react-D0jAj7dB.js\":\"3eeae01a3ed1779e\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-DU4Zl45b.js\":\"d4e4c1d442f0fc03\",\"/knowledge-medium/chunks/react-dom-server.browser.production-7TLWrqcm.js\":\"05702e2032b030c2\",\"/knowledge-medium/chunks/react-dom-server.edge.production-DcLphagW.js\":\"ea47b22979349837\",\"/knowledge-medium/chunks/react-l5rh7QTJ.js\":\"9cf0795884ad841a\",\"/knowledge-medium/chunks/server.browser-B-CwdmiR.js\":\"2c239b5c47b76b7d\",\"/knowledge-medium/chunks/textarea-CdS5mhaz.js\":\"1bb4d9bf1eaf02b5\",\"/knowledge-medium/chunks/ui-BGPVuoRz.js\":\"3d971c5d71050258\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"1dee6caef5fd922d\",\"/knowledge-medium/src/appUpdate.js\":\"2756c390ec58af2b\",\"/knowledge-medium/src/appVersion.js\":\"ab2333c375de6dcb\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"1b5597c8f3abadcc\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"e51a3701ce4e84e3\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"a7360b02dc583de8\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"392d4bfaf0a3018d\",\"/knowledge-medium/src/components/BlockComponent.js\":\"62b27d9e244ae9c8\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"6257d283e0936e85\",\"/knowledge-medium/src/components/BlockEditor.js\":\"3b3f88f503ee96f5\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"8f6d5558a75f13ee\",\"/knowledge-medium/src/components/BlockProperties.js\":\"5d33faad05a7b215\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"cad6f14a07b17995\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"49d0ec8450bcabcc\",\"/knowledge-medium/src/components/DividerHandle.js\":\"0a591e93a9ca7818\",\"/knowledge-medium/src/components/DraftEditor.js\":\"3da55bb065795812\",\"/knowledge-medium/src/components/GutterPill.js\":\"9b5212845b19fca7\",\"/knowledge-medium/src/components/Header.js\":\"1a504db8a0bd6b55\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"38cc677e7bb10920\",\"/knowledge-medium/src/components/Login.js\":\"331626fbd4cd164d\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"88ccaf85e8935a44\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"4e0d2a2a87a39ed1\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"56e1e32601783c2a\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"bd01a8d37ff0e7ee\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"75eb991302aae6c0\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"ceaa5d7126398cf9\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"79cd128795aba97e\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"d8196a0d2e70689c\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"0e4ebf1ba209e196\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"6dee3b6f6ac76aee\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"d0060277934a9ac0\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"fda50e707a98d0c6\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"e9606e23173b8a9d\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"b5033266844294a0\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"b7b095a77f4153ac\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"11efa7cc24da7f3e\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"813837524af50c5f\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"71a33ecfe6988c81\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"221d8123cf52c18c\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"669aa6cfda800aa5\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"93a441f0df574927\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"7c86d7c6d1103ee6\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"2e2d4d08036c6db9\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"76f3438c14cbdedb\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"67c69a788461a67a\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"fdc7090f98eaf4be\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"99fe409577dc59dc\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"32f88c225f191bc6\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"cbe4b2274efe2868\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"b24f25fe3c864586\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"1fb60db6b439f441\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"90e6e9438d45b95a\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"e84de2c07e1fd22a\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"006cf0ca3a30befc\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"8c682c316c62be0f\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"2b92f149296eeb5f\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"3036011fd6d0000e\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"6175bbc612937804\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"4d3807ec9e4fe1eb\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"168b0ba0950b2457\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"82bd3b770622258f\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"97167b01678109a6\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"e258bc23dcddeb81\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"80f2387bfe1709d4\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"31418594a72662b1\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"678a1b6d884b181e\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"fe17065cbb5e2ec6\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"8a45db9b3f388617\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"d19ba5fe61d0aec6\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"fee7accf17d3d805\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"e599dc80a8f87f8d\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"7e525052693e96d2\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"b0adc076d7c2e442\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"91698327d504f0ea\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"3ad9fc1a5e4c3ea2\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"2f5b97fdffef29ef\",\"/knowledge-medium/src/components/ui/button.js\":\"1d64444de5428ff7\",\"/knowledge-medium/src/components/ui/card.js\":\"46e6607f37ca8751\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"22889500d3bd681a\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"63401e3d26c0309e\",\"/knowledge-medium/src/components/ui/command.js\":\"185882a65327722e\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"def0a180935b0af0\",\"/knowledge-medium/src/components/ui/dialog.js\":\"275dd35fc7a4d6e6\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"387e615754f0c7d1\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"793ff28556ffa9a8\",\"/knowledge-medium/src/components/ui/index.js\":\"597962fef872ca8e\",\"/knowledge-medium/src/components/ui/input.js\":\"5fb58d403c468d36\",\"/knowledge-medium/src/components/ui/kbd.js\":\"df8ddb0cde18daf5\",\"/knowledge-medium/src/components/ui/label.js\":\"b0f8f27337d56356\",\"/knowledge-medium/src/components/ui/textarea.js\":\"2eb92be8f4317ff6\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"bfeadbda096f4ac2\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"85063e0da6ab5b7d\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"ffddf50700858a34\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"2be7a7c616187ed1\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"b61ebbaa2529f6bf\",\"/knowledge-medium/src/components/util/error.js\":\"c4bab7651125d6ad\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"a3f7c343c9e17619\",\"/knowledge-medium/src/components/util/suspense.js\":\"18e39e6a822308fa\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"34a914749b8a17fb\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"bb2febc6d8d5df66\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"6b2ba5a7dd6078cf\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"1210bed75b90e3e7\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"f98351ec48b4e4db\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"85d4a23f6f7e1715\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"6e1bcd6bd67720bc\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"d4fe13bf28e50acb\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"78f172fbc179f9bd\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"ba3b961e930f6453\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"630016379e07d29f\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"6b7cac74e45451ff\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"54839250af8d3ec7\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"1a029d6385f15b0f\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"56b0144514f6be38\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"a426d04e219c1199\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"0c40239526d549c6\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"a59e511640895b70\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"b023cca054be1f4c\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"3d9505ed41c217c5\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"1867b183edac2b25\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"e2460d1a483aa94b\",\"/knowledge-medium/src/context/block.js\":\"943783de36d49185\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"072fcfe6771995bb\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"271b42faa50205cf\",\"/knowledge-medium/src/context/repo.js\":\"8a81f65354ebdf65\",\"/knowledge-medium/src/data/aliasClaim.js\":\"57d3617c19081539\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"9c05ac175ee2fd17\",\"/knowledge-medium/src/data/api/blockData.js\":\"ba366f6170458802\",\"/knowledge-medium/src/data/api/blockType.js\":\"d45a98110c6e67c9\",\"/knowledge-medium/src/data/api/changeScope.js\":\"07c0247c8caaa7c9\",\"/knowledge-medium/src/data/api/codecs.js\":\"3b377878b0247c32\",\"/knowledge-medium/src/data/api/derivedData.js\":\"ed34362a7fb6e2e4\",\"/knowledge-medium/src/data/api/errors.js\":\"4ff8e2e467781b6c\",\"/knowledge-medium/src/data/api/events.js\":\"a66729ee76e87219\",\"/knowledge-medium/src/data/api/handle.js\":\"b56a3fa2a911f87d\",\"/knowledge-medium/src/data/api/index.js\":\"870acdaefb6803be\",\"/knowledge-medium/src/data/api/mutator.js\":\"f572ea2929a3b037\",\"/knowledge-medium/src/data/api/processor.js\":\"6ae21107410a9f87\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"fa2729838f9999c5\",\"/knowledge-medium/src/data/api/query.js\":\"e79ea34a7f4b799c\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"a066fa528afec887\",\"/knowledge-medium/src/data/api/schema.js\":\"b56a3fa2a911f87d\",\"/knowledge-medium/src/data/api/tx.js\":\"b56a3fa2a911f87d\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"2393f36741f75f4c\",\"/knowledge-medium/src/data/api/user.js\":\"44ac574a4d60daf4\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"8829ca64cc6efaac\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"27358d3bc7903cf7\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"f3f7978f2d114017\",\"/knowledge-medium/src/data/block.js\":\"1257d5829f9d23ec\",\"/knowledge-medium/src/data/blockCache.js\":\"65b9eabca8f97464\",\"/knowledge-medium/src/data/blockId.js\":\"7fa3a41ae4ddd6ac\",\"/knowledge-medium/src/data/blockLiveness.js\":\"1ace307644ef1480\",\"/knowledge-medium/src/data/blockMerge.js\":\"85bb5733361ac824\",\"/knowledge-medium/src/data/blockSchema.js\":\"1686d0ad6bb84746\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"5ec790e357b66677\",\"/knowledge-medium/src/data/blockTypes.js\":\"8474f678ebb00524\",\"/knowledge-medium/src/data/clientContext.js\":\"de538b0d2b23ac1f\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"006589196b7f776d\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"6bd36316542a6d7b\",\"/knowledge-medium/src/data/derivedIds.js\":\"71da81b5105e0ba1\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"9c1d67c0af6fa354\",\"/knowledge-medium/src/data/facetBridge.js\":\"625da897baa7c0c0\",\"/knowledge-medium/src/data/facets.js\":\"33ce3eddc6ce0394\",\"/knowledge-medium/src/data/globalState.js\":\"c4518785cb09c3c7\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"3c7050b3ecaf1527\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"b81617394bd3d95e\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"2139219af3c47659\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"28ab7ff211332dba\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"3d9396e76ce4e388\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"e87170450fc6dc07\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"1e76f5fc167a701e\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"7a197a316f8f0528\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"8af6e93788d3b93c\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"f2bfba14f71876c2\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"5edaba1a9dc5bb24\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"665cc2f77cb548d5\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"57fcac6f9f6ab781\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"0eee8f3610417123\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"50f9ebd50aa27fab\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"0db94f844f4dd5da\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"cb4cfe434721a4e4\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"f237c83b4ef2aa39\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"44f63c6193981a19\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"1323a696afd9b60c\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"2157c436faca96a0\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"1bd755b722b55ab9\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"96973fcb21a3e919\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"556f363c0349aea6\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"73d1354a1ec9b5e7\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"b5d3710e261910ae\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"3906c15a06624a9b\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"2bc78cc0c0875dd3\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"484e2efa721172f2\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"f5851c51cfab656c\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"e832076a0555e940\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"97e82285e68c405b\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"85f604a6763e230d\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"35ffe044dd55130f\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"d7657974f01f2c28\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"ddef73fcab2a3f38\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"680e83fc6c78cabb\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"be2d8eb4b891331d\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"7fce30818da60d56\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"8d75eeba7478255d\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"6e384368ea2d0c9e\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"5f593ee00c458c7a\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"3be988a81ab607bc\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"ffa24e25387f29c4\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"5946a53a5a46ad9f\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"603a595efeddcc1e\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"0d814de8bc013048\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"386f58038cc77ed9\",\"/knowledge-medium/src/data/invalidation.js\":\"880b4322b1643847\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"b927045ea65defcf\",\"/knowledge-medium/src/data/kernelPage.js\":\"44b8e4cf6d699701\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"2e53ce3dfddc9529\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"9ff088f43dc5c7b6\",\"/knowledge-medium/src/data/localDbStorage.js\":\"147c389d98f9d575\",\"/knowledge-medium/src/data/localDbVfs.js\":\"2af29db5fbe9b51e\",\"/knowledge-medium/src/data/localSchema.js\":\"69ca67ad1e974a5e\",\"/knowledge-medium/src/data/maintenance.js\":\"eda69653c7425fb3\",\"/knowledge-medium/src/data/mergeProperties.js\":\"787f4c947994d607\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"00d9dd08b605eda8\",\"/knowledge-medium/src/data/migrationsPage.js\":\"1b1a415b1089d711\",\"/knowledge-medium/src/data/mutators.js\":\"b5af6e1813ac7161\",\"/knowledge-medium/src/data/orderKey.js\":\"8957ce8fb9a33f52\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"241fb5038998d869\",\"/knowledge-medium/src/data/outlineSurface.js\":\"5c76af98a5625656\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"87d74c29a56538c2\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"2ca57948996d89c5\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"f478376728195ed7\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"c9dce89370c9f7ee\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"416b9a0e3168d155\",\"/knowledge-medium/src/data/properties.js\":\"a1203877612d6202\",\"/knowledge-medium/src/data/propertiesPage.js\":\"2cb98b0dad13decf\",\"/knowledge-medium/src/data/propertyChildren.js\":\"bc16cefab075d50c\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"32b41c8336ee8feb\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"6c5f5e797af38a3e\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"9fa445348373c880\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"9b95aab5256fcf79\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"83a96a14e119b62b\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"0b8fa28753704b26\",\"/knowledge-medium/src/data/propertySeeds.js\":\"56388dc75abf0361\",\"/knowledge-medium/src/data/recentsPage.js\":\"59420daa42aeb0d8\",\"/knowledge-medium/src/data/referenceBlock.js\":\"f5f33aa514cee4dc\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"3a45667b7c1d7bd8\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"aa30be58415a7822\",\"/knowledge-medium/src/data/repo.js\":\"d296a8579cfb0a53\",\"/knowledge-medium/src/data/repoProvider.js\":\"1099df5f68554dda\",\"/knowledge-medium/src/data/rowProperty.js\":\"789f5d405d7e7ede\",\"/knowledge-medium/src/data/searchFilter.js\":\"81d518504304c51b\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"98d5cbf92f67e00a\",\"/knowledge-medium/src/data/stateBlocks.js\":\"9928fe2413e79aeb\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"d50629dd46244666\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"27b8f233911e2c06\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"b516c29493b1a5f5\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"0da62262781d8990\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"3490f115db61c697\",\"/knowledge-medium/src/data/targets.js\":\"2801d448b6f31f9e\",\"/knowledge-medium/src/data/typeColors.js\":\"3e2f6482a2c03c67\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"db918d468e11dfae\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"e8b8e2688c4b5284\",\"/knowledge-medium/src/data/typeExtraction.js\":\"c5192156a25a4962\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"775da99acbca457d\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"537801e0a56cfffb\",\"/knowledge-medium/src/data/typeSeeds.js\":\"a9f262ff3f21ed60\",\"/knowledge-medium/src/data/typeTagger.js\":\"50c34c95974ecc52\",\"/knowledge-medium/src/data/typedRecords.js\":\"a59689cb3409db9e\",\"/knowledge-medium/src/data/typesPage.js\":\"b8b5c2c4c3ce0a9f\",\"/knowledge-medium/src/data/userPrefs.js\":\"3e37c683b41784b8\",\"/knowledge-medium/src/data/userSchemasService.js\":\"9c66d1662e85c880\",\"/knowledge-medium/src/data/userTypesService.js\":\"719eaa82bbe46515\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"06457bbb4eb45e2e\",\"/knowledge-medium/src/data/visibleChildren.js\":\"ac80f114de26775d\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"2ff3f6ea59fb7f6d\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"da2f961a6708695b\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"eab5cc703cd5b625\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"6a89b96903c587d8\",\"/knowledge-medium/src/data/workspaces.js\":\"1a00ca3c8616ee67\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"7634cd8701227650\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"66d77b564e61ed55\",\"/knowledge-medium/src/editor/atTrigger.js\":\"e34d654c61b0eabc\",\"/knowledge-medium/src/editor/autocomplete.js\":\"4092a8df88d3f0ac\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"15e65c570ec9bc62\",\"/knowledge-medium/src/editor/contentFlush.js\":\"ba1749241681d206\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"be4afcb0f0a658a5\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"278d7cfd93a06341\",\"/knowledge-medium/src/editor/insertImage.js\":\"082bb5b5f8c9654d\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"d6b83770a6aa94eb\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"bf1529277400403f\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"3eaa4d8d26c9cfbd\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"753d0ca33cb1e30d\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"9feb3059505a720c\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"4897b46ace117273\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"0e8bec84395e32ea\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"e61eb8f1d5bebd7b\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"67acb87ac59a3934\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"3d63b4726e9ef88f\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"0bc9a8a0a9feb6cc\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"ee0f4834bc5b3bc5\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"5ab7fe13888e7d62\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"601fd75ac6703edc\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"a5a25492e5a0f65f\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"3d1b31593cdfe568\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"08843278492f99df\",\"/knowledge-medium/src/extensions/core.js\":\"cf8f2e64e86777ee\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"c9d691d2d871b0f8\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"57761a0d22af8fe8\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"c3c605b795993685\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"8fc4e72edbc72fe0\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"ea8c5c5f97d208ec\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"29b18b62eb4641fb\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"87c32f51f73789e4\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"857c7e9e50999a8a\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"9a7f8cd5a0f6c6a3\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"32dc215df4f9321f\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"1dac0723a3a56b66\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"316c69719de490f5\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"76ed81558009b972\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"f1f2f70b0395ade9\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"20fff8a1c08a492f\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"3047de94c126e2f0\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"acaebddcf9b22781\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"292995a4812caed0\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"d6d6533aff3470ba\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"2227b9a3ef3bdd1c\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"cbb68ece58717af9\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"3ee728845ad421a7\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"40e6285e1b6c81f3\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"0da57d88eb744e16\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"44828586f2fdf60d\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"f32d1a830186bea7\",\"/knowledge-medium/src/facets/facet.js\":\"6cf33e069d47005d\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"a3dfe9882efe9976\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"282dc7a1c100e62c\",\"/knowledge-medium/src/facets/togglable.js\":\"5650952e88519655\",\"/knowledge-medium/src/facets/variantFacet.js\":\"fc58152845099f2b\",\"/knowledge-medium/src/facets/verbFacet.js\":\"c2d754f7d17e3558\",\"/knowledge-medium/src/hooks/block.js\":\"3d086ec6d3c278ca\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"824bc4a4afe8a7ba\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"ee5ae9ea88df4b26\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"f5846b11b3f3a83a\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"d3f434441c9512be\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"fe0cfc62020fe11d\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"3cb13248791bb4b2\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"0c1dbf1ad945d3c8\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"9614b926cc04dbfd\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"b7309aeab7149524\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"66f23103ffa465c4\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"8b12a4ac7d8f1fea\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"5df4864d0063e287\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"6f0ced6f6648addf\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"d7bc3fd633890148\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"a0cb834063de9765\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"a983ab4b29bb8738\",\"/knowledge-medium/src/lib/utils.js\":\"de06f94e44a166e8\",\"/knowledge-medium/src/main.js\":\"88166f5ba749ac66\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"52373ebf0cd915dc\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"2db6b764b7cc296a\",\"/knowledge-medium/src/markdown/context.js\":\"609a0b89ebe92458\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"6d3375e80c9669c8\",\"/knowledge-medium/src/markdown/extensions.js\":\"bf566be3da7ad8ae\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"fe453937e286229e\",\"/knowledge-medium/src/minimal-editor.js\":\"bf128bf53307f2b4\",\"/knowledge-medium/src/paste/armedCut.js\":\"3a48983ba01be4c8\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"65dbca3d4a9228a0\",\"/knowledge-medium/src/paste/clipboard.js\":\"64c1738bf7c99d98\",\"/knowledge-medium/src/paste/decision.js\":\"9a9c32a626087a5b\",\"/knowledge-medium/src/paste/operations.js\":\"204ff8934c00318f\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"3829744a89c5a46e\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"86c704d649ced640\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"7a4c9afc2dd87917\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"b6e950eb34fd404b\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"7cd0596b5526798c\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"b3015c29cc60e6d0\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"42f1cc4c81e7dd99\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"e014db79c6560132\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"88ffe9fadf2b2f5e\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"58bd29d287eff8ec\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"2488a19a7c4b5abf\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"a135e93b25a4ddb6\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"7a62c5a5da65308c\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"3feeb4a8b7366ec5\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"ebab849222b167f5\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"ffbb72276d672a4b\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"1cf5a220395d4f5d\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"bc1c587448b3c35a\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"b00c31d00bcf680e\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"927969694314b4c8\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"d7ec153d44c20a5f\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"e19d51deca154dbc\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"6a49673cde79e004\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"291b6ead032de15e\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"7dfbcdb63bb72c16\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"92690b774a523783\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"3ea4fb711e8e4a75\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"7efd84fdb7f3fe6d\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"e5c38b6cdc5fbb5b\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"041997bb61b61e85\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"c540d9c1b3625bfa\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"7457acd1cedc2463\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"efaa2a8e1e0e7700\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"ad0d290ecaf02ff6\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"fff39a2ab4ee6c06\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"6a3cbec232c92d3c\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"4f89d74f018fff16\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"f295c558ece2fd8f\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"0e427c79e1b3fedd\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"b37037d91e6ef1b0\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"58b58941e00b1011\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"0ad7cd8160ce5e75\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"94135a314753ed78\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"8c6dcadc17ff943a\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"2fb05e20c5db3167\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"e5fa166a235b42b9\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"9e87a68ce8d2368d\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"7c55300460068b8f\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"bf53b6387d2b48c1\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"06870b9773e71cf1\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"0ed9e7e20c6d257d\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"412f8dbe84f83dd7\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"1c1b5a4bc94446ad\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"c45bdc63e45d74fa\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"82316bcb794fe216\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"4bce8c2076750ce0\",\"/knowledge-medium/src/plugins/alias/index.js\":\"5a64250d5e64d869\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"053afc5ae1857551\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"5c6a1279e04a8ba3\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"e9771a9958d2fba8\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"d4673be959135191\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"e4edfa8f522c5bb3\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"ecae4bb0be49f8ba\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"8245aa04a122d465\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"12b6ba0ac2646076\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"cb51922509111344\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"255856cfd20151b4\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"9c4a4f45e1fe0b07\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"a19d988f50aaaad1\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"8c2d8dce273f413d\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"d0bfefb7f024c131\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"4bf8b6f1328bb007\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"bf7c16e4eaa98b74\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"9e5bde280adc832e\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"f88f49f9da7794fc\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"6255144031184360\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"bfcefcc54b4d0d2f\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"d4da192bda63983e\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"9d77ecc06e0231af\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"b56fce524c755641\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"d7f915ce8500da3d\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"0b42dcf759c79664\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"b66aa865424bc51f\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"d6ac34f99bc57fc9\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"9296ee67a7e44b89\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"60986add42d203c0\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"aaf0b8b38d9b9508\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"ae0e5519e13132a9\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"af1ea0a591689bc1\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"39bb42051f5942b8\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"de0473e3039b5005\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"1045dbe5575ef14f\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"bc8b4ef1d9185d85\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"fd4edf3365dcf97e\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"63b1e60e4dd4e3ec\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"cd030800c410cbeb\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"7ac947e36a768835\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"658771e907038f06\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"837ea8eee9acd06c\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"0cf5e48f065f80bb\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"e694d1b1d18d2eef\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"e6bf47d2ca08f31a\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"1cd4709681ad646e\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"9bf4aebec477fd89\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"a2ddc7e8187f2f08\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"5c043d4be48bf8e8\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"e0df87d7bd457bf6\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"6a1a828d7efd0232\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"095b38fbc4d94259\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"bdb5acc063f22765\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"c1f6d82f9c822067\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"723e94b1567b810f\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"4244a90a8e95fef3\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"54405f85bfe64bc0\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"902cab4f0944ce08\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"3f7a29d3b35f9218\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"c9ebeb034b4f5681\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"d1bc3cd35780e75d\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"ef5450fba0cf5bb7\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"6a9974eee58fc95d\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"6508ee38c2b54d78\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"5a75c7b603c5fbd8\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"773207f8ea9d4b8c\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"9b11ac003e7c7a17\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"ed508c8fa10fd2da\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"063939863bdebe88\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"72fd076da31d87a2\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"decb573a6b591c8f\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"34714621187da329\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"5953d1237390d19a\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"35a9b1e4418a1319\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"4dac5807b5eeb212\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"8cc78fcee398d575\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"8a2aaf03f8af5c80\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"81d28250e2f39893\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"a27f126f37d0e304\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"fcedbb2e73365983\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"ff4fe4adafa28bcc\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"0ab510da8a470a1e\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"f0fca6e96d565744\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"b054d1e3d2891602\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"b4158bd4e6c09ac0\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"2be49de2dc18d421\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"c687d919757d5904\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"7282dd31b8b4cf59\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"764ef375b2a2c2eb\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"0b529940d4c64037\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"c6191ba861ff1233\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"1b6ae1a237ab6b50\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"95cc908679294d17\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"886aa029bec34f5f\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"7de99705db18dd82\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"dc12a162b17291d8\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"0a2fbe414ab07cd7\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"0dfb2bbfa3320178\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"872ccc6911576c11\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"36e43ac1a458a08e\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"adef1de8ffaf4751\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"fe142b0077856305\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"0ddaad3812593888\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"9c524bc2416d8c58\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"a7e92b5bf21e1259\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"f1ac765c03ce3e17\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"028627f81a1cad23\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"f8a385c5721d37c7\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"d7e1e23f11056795\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"d0abbee0299e9010\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"4d5cd563a9864d15\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"a4e8201025b03451\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"fd2722b9cedeb546\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"74b4ad002ad10aa0\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"38492160cb55afa6\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"5f7773e8f7c33260\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"024f1c1649c1ac54\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"5fdc4d935ceffc52\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"bb722394204da01e\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"7b1869ab3d43f964\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"386d6370c6cd1b2e\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"947b062fb99a8d9a\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"9f3d5784964888b6\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"c229d4e73528471f\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"5f5206d7068c83fd\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"011a58dc07393476\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"938b3b01b3372831\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"e87869dabd316d81\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"60fb4b25c8c41606\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"de885bc90e1bc988\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"736c4e8f877eec58\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"265182ff008b3c61\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"e92d0a74adbac590\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"b773eb2128e415eb\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"08a741bb940639f9\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"311345a760647f96\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"3a1bb0955afc6eaf\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"33a191b85558c7ef\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"4b47715d323a5726\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"e6799777576ce750\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"efbe32fc56ec4090\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"3c97bedb8cd9f822\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"e683f0b7efd6bdcc\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"a1a210f81962bea8\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"49bfec8516804039\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"ed42098834db80c7\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"12db17367605448b\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"5774639300d03a1b\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"2a66ad5147716834\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"5eaa6fc6c3f9d87e\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"0233c86f5059f752\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"edbb3542f09b9798\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"f8d4a4de5df98910\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"c21ab6c9865d1b73\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"5ad50a7cb0676b19\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"0816b8e41f78ace4\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"0a9061447a504357\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"3cedceb9c265cff9\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"4a40e7cf43ad74d8\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"2d6caea808d55f6b\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"56a9d78bf9c18c17\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"70af5ad0aa7c987c\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"211b2863fe015b2c\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"36fff97592bcaf64\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"64abbd79c361e6ea\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"8cacb18b02858372\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"26eb5a7288bd3e93\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"12d7dc84fea9043b\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"baec5b118b9062f9\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"02611b96cb3c716a\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"19bc303d49568c30\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"871edee79757f7d1\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"a0485bd02bb5fbaf\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"ee04eeaac1ab6359\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"66c05fa4f4d3e51b\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"95da6f7b754fbaa9\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"ca1924566c1f158a\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"0b5ba1909b7454de\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"1d01a324db85da14\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"1e6a1f9818faebb1\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"0219bd01f9388e41\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"bbff4e6b6aae125b\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"8b4fcfec67ad6751\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"504ed4d3d5300b8e\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"53151723d2c09921\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"d7bf6d37fd475e2c\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"edebcea8d2222ec9\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"121aea1eb00d1a9f\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"b430dcad2118bb59\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"654aef849c3c2f7b\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"0b8e5a15690238a0\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"9bc4be3d1124130c\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"1d25cde034df261f\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"a5ec831ca44cca5b\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"1160acb94494a5e3\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"b049b9afa0bd92e4\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"4fcd151b659edc8a\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"603ef6c4a937881f\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"bbcecda4d3ba4f89\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"ddda5ecdd76f0953\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"53e5cde4e92fb1e8\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"5eee992935ac36b7\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"56c5324286f458a7\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"200aaaa20352173f\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"2fe5d6973b8f97d0\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"017ced3265564708\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"d2f7f8822a8fc46e\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"2f2f9948ab58f591\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"98dcd441f90f5595\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"94b9ddd1ba0a7291\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"bd9cdd22a2787491\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"02ae1b6a33a9417c\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"1034559bc05ca539\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"3c574c7c392443a3\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"8a2c1cb1dd8e534d\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"510c5f0124abe623\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"a8ca3cd3c8a7ef9b\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"5458580eb906df90\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"ff6977450b1865f8\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"cab7037e5178a4ca\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"e4f29372b21e6678\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"dd0e0b778dfdbf65\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"1c4155ca1c115605\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"290dd5bfaf4f5c1b\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"53d1764653424543\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"6e18f9f5c000f675\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"180d6bc54fe4d03a\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"9b017eecd2112b96\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"c7ba009a8dfb9a93\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"bf7ac4d910a54151\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"ddef2a2a1b011b92\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"32ad11b6e4fa840a\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"e5e8fe5bc027e9db\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"88b06e0c1ca0b7f5\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"ca96208174e1f145\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"d2b7495a47006c37\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"03c834f1485f1901\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"f5e77e8eadbda403\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"c72494a3346a02d2\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"c3191cc7a8c9eb67\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"d26a618fe751d437\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"5bfe91b81c4b3d5b\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"7465268713f7d131\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"f1b32a9b3033f8b6\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"b64d937ad32a3430\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"36adb52d77327d09\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"f69d55cb7d622156\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"b6fb179e84c1cb29\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"f1cb719cab9c0dee\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"7e9c8f48aabc0ee9\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"865624b88aa4b0a2\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"f8f4312ef56f8dad\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"251fb12ce05e63e4\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"56772aeda0437611\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"1dace6ec208ec6ee\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"6db84883ed4c62f6\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"0a7d36ea3ecba218\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"f6eefb44f307deda\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"0c92c9d358af954f\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"c8d2fc7935232df9\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"c23b2da695f0132f\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"623fe49dea3fcd65\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"37d4da9261db1825\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"ce40ff501c5abd88\",\"/knowledge-medium/src/plugins/geo/index.js\":\"39bf88d2d08a2234\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"bde6a5c632085950\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"4a50a26b9536d627\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"9ec62183932807d5\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"79ddff452d98f907\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"a27d8790236c2936\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"e4c3e66df19badf3\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"1661cd4395e13a3f\",\"/knowledge-medium/src/plugins/geo/query.js\":\"103b73704a5f5889\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"c5ec124642142fc0\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"a027db22d6dbe63a\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"a6d9c2aa918bce19\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"d198973659ee8b8b\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"3dc4a0a19bb03271\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"ebf31063714e5cf6\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"481e27d5560338e6\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"6f3e4441a0bee3e9\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"b0aee27d574697d3\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"094551b605563d73\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"f878b409b6d7cb24\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"3fc4205f73569ef4\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"abe5186d64baff01\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"732f8aca1635039f\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"006e943e7b57e1e7\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"cf3f966894690cfc\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"8e85dd3ebd104330\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"a8e40ad99d08dca1\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"ff5abe893689b588\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"de1629001d92a49a\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"87d055c082989751\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"d360875be1f6058a\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"15a8eab2545d7072\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"a7826be62e0a62aa\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"c96ba4a42667b1f6\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"cd5d64ab68cfffd8\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"8b9c08d1dff3aba1\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"fcca27d78fd3b9ec\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"de3b393bb4a0c64b\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"c1817688e16d60f9\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"e7db84b2a1ded515\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"4e45b0d7944f8b72\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"07d997a731584e7f\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"c2a8fe572fa59b5b\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"abcee5bbd7821d98\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"d24f559d41e06b9d\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"18c4330879ab04ae\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"b5302b798885214e\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"82deb492b886ad71\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"937ba3f5cf59eb5f\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"d869cbc08df7d1be\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"3a6aa1a8cde19a43\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"ecd731dff6f5dfe1\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"d07d488183c61c9e\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"10c034dc9255bc51\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"14e4f04c35745413\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"ba4ab8b136ed1aa8\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"fc1f7197713342ba\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"8ba21eab0b929b4e\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"8f6acb1ba64cdd01\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"06cbb422afafb955\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"82680f34645ef6ee\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"f5de748c4b24ab26\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"08a7b623c8e8080e\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"067a7315a6e18d6d\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"068c7c6374e9722e\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"29f176f75cd90bbe\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"eca38dc984eb57b3\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"faf4efcde3b53794\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"fd50804e8ccb0136\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"25308ca26110d223\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"9539ec9f59320ee7\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"b443493a36abd64f\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"3154967b085b2b0d\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"fb9c69c7f9d2850a\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"d3f00a2c6e845261\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"8c17effaa5dfd80e\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"4765f846d76af1be\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"496b5991179aad8d\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"7414f71c72dbfc5d\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"f2bf9d8bd1ab40ee\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"f8dfed0d6a4dae80\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"4340922c41165ba7\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"7bcc0bac4d12de4d\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"104bc397bdcc7078\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"745cdb85e392a70f\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"90168623c14e83bd\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"1427ba2a06bdb0d8\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"712f8c5469ce253c\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"61701c55c987efcf\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"9528d7aec7ec022a\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"ef65f685a010b9cd\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"eda049e7fd11cfea\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"0eff3df77d12231f\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"5c903480828d616d\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"403e450c29c8b381\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"1615cbf15e3a32bb\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"8b67254a259c0864\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"74d18aaa4c2d9623\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"87d7ddc6f2ed014a\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"e31bbb283ae2d7ff\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"34d416dd44934e8d\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"c4371e4d4c39b000\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"72eb1d5a78041972\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"4fef6dea80ffe55a\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"3ac8cfede68cff51\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"1b46b40903159114\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"17ac0f33ab308e1d\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"d25c2ed337edae8a\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"7442f93bb94adae2\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"76d42a35b35b4fd3\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"089ead3878c1e443\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"21d5de611b1ccfca\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"9ac2a875b04e7b0d\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"098934aad864ea3b\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"f69388b955992266\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"7377a4108ec4fc0b\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"af31bd7071e61a81\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"60c8da8e56e55ea2\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"930247441da5bd83\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"952f3f8a7a9e8d9b\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"0c8eb5184f8e6756\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"b87b027978ee8704\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"719e2b1990a72d02\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"0646fdb06837abed\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"18ed803d97f7e228\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"7f8420a342179f7b\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"284d24711db70ccc\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"97df460792ab5b52\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"73e745a3efa4cba0\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"f0e70248a15778ec\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"2174cbdec57954ca\",\"/knowledge-medium/src/plugins/recents/index.js\":\"f15e0798fb7a7981\",\"/knowledge-medium/src/plugins/recents/target.js\":\"d5b58c170c10ff52\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"24b020ed58d66ef2\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"287c277e12ac5f15\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"3491743243a0e971\",\"/knowledge-medium/src/plugins/references/index.js\":\"ad55c5b6ccf7beb1\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"845217ba1eb7e207\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"9a6f2534347fd998\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"cd6877a48b9f24da\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"87a40f4b60ee3bca\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"7228c17fcaa6c6c0\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"e5911051e2c9613c\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"9a9f9087501ab878\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"98a1bf419d2333f7\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"c8afc6376a3e4cd9\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"d4783d753942c97f\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"94487bd52032cf80\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"fdb8e04d26b1c4e0\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"50f7d3acb7306b81\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"4386ce89d2b7bdd9\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"f0e9a3c191f6235c\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"410fc15796e92367\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"c435356bd2194050\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"f8eedc1ae001db93\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"60728818d3feeb22\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"ef29847f50e4432b\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"0d24df4d9bbf346d\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"05a3572ea08cf72e\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"e2011e8ba3a342f6\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"534f8b740065516f\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"c506447763c58e16\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"956c7c61987820b1\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"30aea2f1789a19f1\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"d7109a6da88f8eb2\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"7dfd6f1b88d3b90c\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"2582e59ea6983197\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"c8cee503c91fb48e\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"bdd15e01f334cdaf\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"fddcd5d62877e3c6\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"b76ce898aa5b0c59\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"3b4e511d8915aba0\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"3f4775468375a97b\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"bc751f03baf8d717\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"7f5530b2e4233429\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"32be597380fa1640\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"4633a93498ee4bb5\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"be09898d427bf303\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"ac8327f89232611f\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"6dbd5026e7068b45\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"b6d48598de53d002\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"3957a2d45f3dae24\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"2b91378a420633db\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"5df1b1238d82046c\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"a9baf2f803377d12\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"1b6b76a7589d6a46\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"d71e5c74da94823e\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"5b3e7e8884ffe5ca\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"5d71f821ab779ad8\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"b99a52f3b816b879\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"a10d145b072f7412\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"6d9e48e31971f160\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"8a5e576008fc166e\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"431381a82ae56a5f\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"b1933c3cf077f67b\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"24c568150afa4c40\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"b89fc9d82a13121b\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"63e2fb66dd105034\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"d8fc39fcacd3692a\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"c628b620ec679d2e\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"25b3d72defe17bb4\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"2f6d86a83990859a\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"65d2e4e7d2258667\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"d14d33588d5eeb40\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"65a9e93201d1e7a4\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"e5acd4c01d7f1d6d\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"1658451280311820\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"f0c2ccc4062a9b8f\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"bf495f575c5ab6f8\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"4869993a6c2418bf\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"43c7c77d6256bdad\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"d6a99c88b0c0785d\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"3855839026ca28bf\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"b9f3b3554bb21279\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"31c9a5cea4c79d1d\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"c10ecd4e3a9d4e94\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"62f8e55f514c1089\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"0b60960ec089bf19\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"3c9f4dea3142a937\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"102e081a78f7a61c\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"b33873ec9ddad173\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"ea5f6773485ed3a8\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"2bd4902203d435f3\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"ddcae340f88402ee\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"c1b668fea32f7241\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"2fe3c78f98469b30\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"3ef40301a545ad2e\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"f25def60f036932e\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"d21edc7152c3d455\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"62f48c42dd91cc1d\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"70f6a23b27fec42f\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"3e631f8e33dd1962\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"6f94224733cf7e9e\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"8050130755f6e327\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"3e86ec1c96fa1514\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"ebafa1839d76d1d4\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"2bb4e42e9be3b194\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"a8d30832a7409e77\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"9e2748aae33f9a9d\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"2f925322e01fa737\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"0e58a8578424b400\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"5901bf4b8d3edbdf\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"11c638991b1cc5ff\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"a0a66583c4865c91\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"a16054e7c7b84174\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"53d5051590baecb6\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"9948c4061456aed1\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"873ff6582da69ad0\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"be0f728139b0b11f\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"66b677788ee75967\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"35acf7d37dff1233\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"90ffee2eb52723b5\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"a631379450962146\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"b013975089014c60\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"89535985b8fa158d\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"ecbd13a4477cbe35\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"d7fed08e8b467435\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"d6cfba18b0bc56b3\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"7ca5c43a860a76d2\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"8f305a713e6148b7\",\"/knowledge-medium/src/plugins/tables/index.js\":\"afdd7a48ead7feed\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"bf4eb024020ae4d8\",\"/knowledge-medium/src/plugins/tables/model.js\":\"caf72d2f60ef0254\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"033f430aa4d503c7\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"037043fcf6d6a3ad\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"1e6fd23ed4ab2289\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"c73693c693697d67\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"86a99151d7c09406\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"0929dd1242e838ee\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"ce6e26838e81befe\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"c1018659cc286fdd\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"2d6e6ad9442c5c07\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"e2ec51b8ea8cdda6\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"ca03604edb4d99a6\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"efa7eb45fdf451bc\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"72f7ee6b436c2864\",\"/knowledge-medium/src/plugins/todo/index.js\":\"172f2790fae366ad\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"4a55eda39a07c806\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"dfc83275905b7852\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"cdb2debbe1fad217\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"5f33d16bad968389\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"d2c50c82ef56a2af\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"3edec9dbd5647772\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"fb9e33817fa213a7\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"7d75dace92a14d42\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"cfaa613933ac63e7\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"d42f22735cf20200\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"0fa0827de053bdf9\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"b8036660077ba232\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"b728a7315f8a1268\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"4d5afde497cd99c6\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"75ea2f9442d6bb8e\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"5633277ee9f4d8a1\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"9caa8b8fb6a31079\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"93e8e9bc809908ce\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"ca37d8329910aaeb\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"224f256916e2e39e\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"e5ed1d62e9fa1d24\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"001c29ae425ac76a\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"a9986ade950a3e14\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"1d7bb6a3ef19415e\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"1deda587da3bf096\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"24a7bd92dacbd7e7\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"079ffc25a7f70ba3\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"ebc12bf7d77f2c7e\",\"/knowledge-medium/src/registerServiceWorker.js\":\"e191cf56a1046380\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"a2e9c1b54a4de7d4\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"d3163d04c2419b7c\",\"/knowledge-medium/src/services/authStorage.js\":\"a4287b54d2ce1b23\",\"/knowledge-medium/src/services/powersync.js\":\"43ad8292ea12e905\",\"/knowledge-medium/src/services/supabase.js\":\"242f4ac5e1959eef\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"ff17a698e3e02bfe\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"7d95fe255055a86e\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"7d9b2eebbecb6a51\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"9f64fb651cefcb48\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"ecaa6a6a69683afd\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"7c7f284ad2f627c8\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"73706aa5da4ae6f8\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"4f6c4a6f7584ff75\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"5c9db7b597869aca\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"85eba14f93a1f9b3\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"2d6295bb7de2f2d9\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"26389988b9aa442d\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"79175c713c988ca6\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"7c1d43aff61ccb3b\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"b58742c5fe718ae7\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"f763e38594b511ef\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"c50ec010c1555708\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"0628e34c1d5da2a4\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"329aa3c68ce31563\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"fe31e14872cbba43\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"e033c44f54ac2f17\",\"/knowledge-medium/src/shortcuts/types.js\":\"573d2cb82ea88106\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"6020f16a48a5f159\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"9b62c099b63293e8\",\"/knowledge-medium/src/shortcuts/utils.js\":\"002709ed2c87b509\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"604cfc36de469c6c\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"19caadb701471e1f\",\"/knowledge-medium/src/sync/byteTransform.js\":\"48326a6c2350ad95\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"2ecbf4a631e56880\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"0d2a1a3d3a276a64\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"ced22f68d6b22239\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"c80fd565528d36c2\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"3c3cff094ab6fbb9\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"c6110cbd00a69455\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"fe1a129e2bbbc423\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"1f482dd38c923070\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"1e2af7fe3b63d446\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"71d01b6723a7e0c5\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"1dfdb4a1a15a126b\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"2c3753f5c2e8331a\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"0b33f416fc2624cf\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"f9c08666049031d2\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"5588e649e517f423\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"86815de56f3e5c2e\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"41dd09fbb504e6dc\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"88ca79b3abdbe8f4\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"41ed93e9ec746e33\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"49bb1e2b39934cd2\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"5c4c8b76fad9960d\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"f79df002bf554e6b\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"549f52dc7ad8f38a\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"abf2a503e47d8f82\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"7193884649996d7b\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"af8758e3575d710f\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"46c134160c9fda28\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"eb64e0699b7150d1\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"471a3e6bea724aa9\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"fd9afd65c0af7af3\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"9cced7e67bedc117\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"9da98faf184bdeb3\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"2f53d6afe9bfc049\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"5020610e3a11d457\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"577ea7653b45bf8b\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"c8e04abd112ea0d5\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"9a22fcd244265634\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"4b40f3a036f02433\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"3c99aa5e5daf2373\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"b99ac780b41fbdfb\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"8c0e073603084359\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"36734f0d482613e1\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"ec629a971759f310\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"4a8e773e11789d0c\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"f505f32cbe208cb6\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"54e1dafe8a14b7eb\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"b06b6bae826dc8f8\",\"/knowledge-medium/src/sync/transform.js\":\"cf12f1bcf1c4bf32\",\"/knowledge-medium/src/themeBootDefaults.js\":\"7f83d7ee9a8d80ac\",\"/knowledge-medium/src/types.js\":\"f0eb356e1a0b6d83\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"f9d1458c73e49b44\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"2bec5436c239279d\",\"/knowledge-medium/src/utils/array.js\":\"2e8ca45dc51f0522\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"2faf363169c46657\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"50dce7f637ed1226\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"b8817229e90c430f\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"1c5d6613c8ec9072\",\"/knowledge-medium/src/utils/callbackSet.js\":\"f81fe2f6c849559c\",\"/knowledge-medium/src/utils/clientId.js\":\"a8928852f564f0f2\",\"/knowledge-medium/src/utils/codemirror.js\":\"60b74837262e68c3\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"2f4603ea090e7d95\",\"/knowledge-medium/src/utils/copy.js\":\"2d5b26cdd872c2c7\",\"/knowledge-medium/src/utils/dailyPage.js\":\"e9b8467dfc2f2d39\",\"/knowledge-medium/src/utils/dbForensics.js\":\"d6b8510b40ac58ca\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"d902674f46974186\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"afcffa94852c437e\",\"/knowledge-medium/src/utils/dialogs.js\":\"ccc75e69afc7d76b\",\"/knowledge-medium/src/utils/dom.js\":\"a1b814f65a45c486\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"e9316c518c8ddb70\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"76b4ff98cbd4260f\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"ed926a7158f45fde\",\"/knowledge-medium/src/utils/flipSlide.js\":\"0927436b17fba309\",\"/knowledge-medium/src/utils/fnv1a.js\":\"f572436ae9e783cf\",\"/knowledge-medium/src/utils/formatBytes.js\":\"6291ffc7d6257dd5\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"096e4ce96e97c4f5\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"bf954cc16b9b9305\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"bbe9d475d2ae71f6\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"5fe00a8162d56a1c\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"a1c679f2e80fdee3\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"a2b7a50b1164a5be\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"e51409f78d1d3343\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"a53de562375691d0\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"5fb52241f41eaabe\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"a4bad8ed1a99203f\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"40648331cc6332e3\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"81bc455c3c54b8b2\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"60f37869b85997fe\",\"/knowledge-medium/src/utils/markdownParser.js\":\"9d2841c76bf248f3\",\"/knowledge-medium/src/utils/memoize.js\":\"fc281d40584583eb\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"0c20bebd6b10c7b2\",\"/knowledge-medium/src/utils/nameList.js\":\"7a78d63cfcba69d8\",\"/knowledge-medium/src/utils/navigation.js\":\"39281b229e8c3550\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"c536fbe5892d36ab\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"37e4d1427c8c7b6e\",\"/knowledge-medium/src/utils/panelClearance.js\":\"7c2a0f1a45f2c214\",\"/knowledge-medium/src/utils/panelHistory.js\":\"954ec14eecd7cd70\",\"/knowledge-medium/src/utils/panelLanes.js\":\"f08063b0ba612730\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"211798fa36b30c62\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"d6faa7565410bde1\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"ccca23808b935461\",\"/knowledge-medium/src/utils/platform.js\":\"ab3f3cceb38958e4\",\"/knowledge-medium/src/utils/pluralize.js\":\"df3a6c1e04a75e0a\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"b72691bd8b1deb07\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"aacadb13c86ec52a\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"c348cdde8a72d313\",\"/knowledge-medium/src/utils/react.js\":\"ff76981737703436\",\"/knowledge-medium/src/utils/relativeDate.js\":\"43a4f11899a31808\",\"/knowledge-medium/src/utils/relativeTime.js\":\"cc93971bcd504e28\",\"/knowledge-medium/src/utils/renderScope.js\":\"8eb4d2debadb6392\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"790dd5bbfe12a34c\",\"/knowledge-medium/src/utils/routing.js\":\"884b910af7be1e28\",\"/knowledge-medium/src/utils/safeMode.js\":\"8d15cddf2361eef6\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"986a84ace898aca8\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"587365609f481b9c\",\"/knowledge-medium/src/utils/selection.js\":\"6840e165d7915a8b\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"1b783623a6659760\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"c979b54f807cda05\",\"/knowledge-medium/src/utils/state.js\":\"0e8ec21fe64e72a0\",\"/knowledge-medium/src/utils/string.js\":\"b944e6aa4a3d79dc\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"1d63b7e031fcaf49\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"e278b3a1b9dcebb9\",\"/knowledge-medium/src/utils/toast.js\":\"eca87cca531945f4\",\"/knowledge-medium/src/utils/toggleStore.js\":\"0151973e55ef01f3\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"603d2f5e55148eec\",\"/knowledge-medium/src/utils/userActivity.js\":\"fc2781f5521675b4\",\"/knowledge-medium/src/utils/viewTransition.js\":\"6490f4b203b3bd52\",\"/knowledge-medium/src/utils/viewport.js\":\"ce5e59916cbfe6e2\",\"/knowledge-medium/src/utils/webLock.js\":\"f6418918a67497cc\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"9916dea46f1c6dde\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"4a80c446e16976ba\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"4126fc58af636523\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"9c9ba34ce0ce235c\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"a547336b8e601770\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"b781e0b03816db76\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"cd68f643222acde2\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"a64d7ce9d6628740\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"6e55a869dda23a94\",\"/knowledge-medium/src/vendor/react-dom.js\":\"869692cddc46e89f\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"059431404a1d9a90\",\"/knowledge-medium/src/vendor/react.js\":\"0f20b0bd8713fbbe\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
