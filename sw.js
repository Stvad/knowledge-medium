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
		buildId: "19073a25772f-fb771d34",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"87553c1944e70b31\",\"/knowledge-medium/index.html\":\"87553c1944e70b31\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"5f578dd8496a0576\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-WB1EPy5Y.js\":\"39e609c251a24f01\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"1cbc8065cc184344\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-r1bz4Jrp.js\":\"3a8b2f6e12d8c26d\",\"/knowledge-medium/chunks/FacadeVFS-D6VBH5gF.js\":\"e8bc0aa8a14ae7cc\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-2dD5WKDw.js\":\"6b861278c28d1213\",\"/knowledge-medium/chunks/MemoryVFS-NAxPdTMi.js\":\"6f2947d4d5425b17\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-B4UVo6DB.js\":\"486d41443b94d697\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-DnAmyUBz.js\":\"dcbd433778206ed1\",\"/knowledge-medium/chunks/Preview-xtpg2V9-.js\":\"daf96230f33ee2e5\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-B1U9iCUt.js\":\"99e38c428494154a\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-DLlkAYf1.js\":\"59cca4a23be938f3\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-B77Lxfcx.js\":\"d5cccc37bc65f306\",\"/knowledge-medium/chunks/react-B_THiyLZ.js\":\"3154c2d66d2738cf\",\"/knowledge-medium/chunks/react-C5fdC5V2.js\":\"87902a2ce67f6411\",\"/knowledge-medium/chunks/react-CwjBEbvm.js\":\"e90ea326f74bff88\",\"/knowledge-medium/chunks/react-DPcYZ8Z2.js\":\"c20e8329ac084850\",\"/knowledge-medium/chunks/react-DUrbm2Vc.js\":\"f041b4859cccd873\",\"/knowledge-medium/chunks/react-DVMGO_Eu.js\":\"0c42cfa99176a87e\",\"/knowledge-medium/chunks/react-RFYM9Ogg.js\":\"82c514f2c49edf40\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-CJjqyvLI.js\":\"075b6e3baf0e2bd4\",\"/knowledge-medium/chunks/react-dom-server.browser.production-lyEY0c-u.js\":\"efa2a1e7911fe9d3\",\"/knowledge-medium/chunks/react-dom-server.edge.production-I52SIUno.js\":\"98e5aa97e105b038\",\"/knowledge-medium/chunks/server.browser-CugXVQaa.js\":\"f8d947fd7fd4a233\",\"/knowledge-medium/chunks/textarea-BCTSKffc.js\":\"b37e6760f08947ed\",\"/knowledge-medium/chunks/ui-6rbEvStM.js\":\"7424e3bf4133ca85\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"40d9a96276afd5a9\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"004d3c5ce4279257\",\"/knowledge-medium/src/appUpdate.js\":\"da0099d2be2312b4\",\"/knowledge-medium/src/appVersion.js\":\"b0ec4a1410f605a1\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"a2d72032056d3d04\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"2581428032966da4\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"e7e1ee29082b9d9d\",\"/knowledge-medium/src/components/BlockComponent.js\":\"39929e14209a77cb\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"8df4a84f830fc3b6\",\"/knowledge-medium/src/components/BlockEditor.js\":\"27abaf2d6e33b9a9\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"cf2c1f374b525703\",\"/knowledge-medium/src/components/BlockProperties.js\":\"507ffae959ae34ea\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"59f7e0d051ddfd28\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"f3fefd1c25347d8c\",\"/knowledge-medium/src/components/DividerHandle.js\":\"6bddd5a49e0def77\",\"/knowledge-medium/src/components/DraftEditor.js\":\"685d6195b922032c\",\"/knowledge-medium/src/components/GutterPill.js\":\"9ebc35bbdca8ad43\",\"/knowledge-medium/src/components/Header.js\":\"7da6f64ee5625240\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"30d4f3a21fe012b5\",\"/knowledge-medium/src/components/Login.js\":\"8c8f7613f021612a\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"947c1ea10deb9bbf\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"f4ec1279b8cee570\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"d890be4d918a07e2\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"8238b64ff0ab321e\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"4597d1952440d8db\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"efa65f142fe701ca\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"ac320936384a9fab\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"4072616ce0c8863b\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"0980ec74f94e7cc6\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"67d48b31cbff089b\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"cb406471b6492940\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"6c5b803a4128e3ff\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"322ae9c668ab2b8a\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"817c04cbba213f5f\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"e21343ebb2a72110\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"828a431bfaed89cb\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"c3edd3fde32a6630\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"3a4b8bdf6cfaec76\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"c7b798e8afb3295c\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"c1c3bd69aaca42b9\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"ef24e0b2c5dfd2bc\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"1d28609749926b9d\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"e1eb3f23be3ffc18\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"cb6633a1ec998276\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"361d32114ad695ba\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"6e4708049870b58e\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"aa7fc3d5a5532422\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"ac02114d5d2305d2\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"0b3a61a5e0cd9016\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"4525086b389399c7\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"d592543b040d2cbc\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"5d25e2b0d8383c6f\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"e91eafc49474dfe2\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"061eab8ef4d205b0\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"3ba94f61ec8bf7d3\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"5e739c59ad50fc7a\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"9965b20089dcc935\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"ee593055c0228f01\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"ee5978b0816eb963\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"09f4d42fddb54a8b\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"3600d7c6daf089b5\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"2743dd42d2634aed\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"289d44b81410fb7e\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"c0849088d34c9fa2\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"ce8b6ac74e68ca07\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"e185a841c6b34ac9\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"52c1da91be587f17\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"df512fe3d7aa02bd\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"473eae3997949303\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"ba9319129df4d868\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"935b6f5483df6f22\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"93fc323850fa93db\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"f6571e5299cf7af3\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"2cbf2dae3f2b3b29\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"a1e59157950b148d\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"b0d3e7692a95e402\",\"/knowledge-medium/src/components/ui/button.js\":\"6c75405f6299dbe8\",\"/knowledge-medium/src/components/ui/card.js\":\"81b98db09a666a61\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"f261c68c1d950cb8\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"fc7eb44046f1bcd7\",\"/knowledge-medium/src/components/ui/command.js\":\"0136e54c1bdcb57c\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"6163bebf2f6020e8\",\"/knowledge-medium/src/components/ui/dialog.js\":\"62b259b5d7b77557\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"1361e58c2e8cc734\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"11318b2e5ce708ee\",\"/knowledge-medium/src/components/ui/index.js\":\"78adf11932f47ffb\",\"/knowledge-medium/src/components/ui/input.js\":\"9c150a95d6664c23\",\"/knowledge-medium/src/components/ui/kbd.js\":\"2e8fb2d9cf865676\",\"/knowledge-medium/src/components/ui/label.js\":\"dc64ba6f810934df\",\"/knowledge-medium/src/components/ui/textarea.js\":\"2fbe01e7e19787b6\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"f47ab4596c274a6a\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"c377d3d1a33310c0\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"5204e22b34d26efc\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"754b62f8f931c86d\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"b2b1bf107191ab4e\",\"/knowledge-medium/src/components/util/error.js\":\"ac1cbb9123b5b876\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"32af84428b376359\",\"/knowledge-medium/src/components/util/suspense.js\":\"6bd0ce4f852566f8\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"63d01469ee82e49f\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"c251cee04fe0abc4\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"8eb292c1feb86447\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"b92f0f179896030a\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"2819c55d43dd333d\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"b558672e000b088e\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"87fd764f1104da1d\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"ea6d9326c7e38ca7\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"dde1a4f248cc9d8f\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"26405853fd76e40e\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"6714baad0491ab92\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"1fca459d23ae8aaa\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"b4f2cd24c7fd5908\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"c5b18dacb8b54d33\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"244a66b117d9fffd\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"abb94b158c2b2dc5\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"facd3c125959e72f\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"05165ea0e4408665\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"d6e96928cd8db86b\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"1f04d2cec67af906\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"4a5b21e6e314f245\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"79bd6edff4a1cad8\",\"/knowledge-medium/src/context/block.js\":\"41c50f8893626dd7\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"ea1b84a57de00707\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"14be79c11307939f\",\"/knowledge-medium/src/context/repo.js\":\"62e063410cae18a9\",\"/knowledge-medium/src/data/aliasClaim.js\":\"2d812989113add0e\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"1835ea48a14445b8\",\"/knowledge-medium/src/data/api/blockData.js\":\"cd31820946bf2ccf\",\"/knowledge-medium/src/data/api/blockType.js\":\"37a9227d9ebee524\",\"/knowledge-medium/src/data/api/changeScope.js\":\"a81d426749d35826\",\"/knowledge-medium/src/data/api/codecs.js\":\"2282e7e5e2e23895\",\"/knowledge-medium/src/data/api/derivedData.js\":\"df3d8fb58b7db543\",\"/knowledge-medium/src/data/api/errors.js\":\"5e36afa824a3e65a\",\"/knowledge-medium/src/data/api/events.js\":\"51909d73773120cd\",\"/knowledge-medium/src/data/api/handle.js\":\"5dbb299cec2cfaba\",\"/knowledge-medium/src/data/api/index.js\":\"abd1a76245977d01\",\"/knowledge-medium/src/data/api/mutator.js\":\"69b866e58e8091a4\",\"/knowledge-medium/src/data/api/processor.js\":\"260ae7b676c81dff\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"6709c7db0bd3ad9d\",\"/knowledge-medium/src/data/api/query.js\":\"52fce02dfe133ffd\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"fdeab60f6aae2fe6\",\"/knowledge-medium/src/data/api/schema.js\":\"5dbb299cec2cfaba\",\"/knowledge-medium/src/data/api/tx.js\":\"5dbb299cec2cfaba\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"25a7372fb00393b4\",\"/knowledge-medium/src/data/api/user.js\":\"6165a0d1d3c9124a\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"0124aedb4b73e8c9\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"b64b5f36179f9ef3\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"9008fc58751c96d6\",\"/knowledge-medium/src/data/block.js\":\"660794b37e079daf\",\"/knowledge-medium/src/data/blockCache.js\":\"0dc88ff126244832\",\"/knowledge-medium/src/data/blockId.js\":\"c7c8c0711e072817\",\"/knowledge-medium/src/data/blockLiveness.js\":\"42cc396dc4696f3d\",\"/knowledge-medium/src/data/blockMerge.js\":\"ff4c4535966d9d49\",\"/knowledge-medium/src/data/blockSchema.js\":\"39f83a918f2ba731\",\"/knowledge-medium/src/data/blockTypes.js\":\"5a7c08995f5c05de\",\"/knowledge-medium/src/data/clientContext.js\":\"9a600bf4a6d0b9b1\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"29d72c02e4c8deef\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"b8561fb4d90ca611\",\"/knowledge-medium/src/data/derivedIds.js\":\"c47b65a1cd78539c\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"c2fc0c114bf47220\",\"/knowledge-medium/src/data/facetBridge.js\":\"753e0cf11e092951\",\"/knowledge-medium/src/data/facets.js\":\"82ea2503567eb078\",\"/knowledge-medium/src/data/globalState.js\":\"aef4c77503e78d40\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"9cf042b5f15594d1\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"8f5e2060bc92ae6e\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"f94abf08aba158b9\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"87b186132cc354ab\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"a6b2bd52182e9b57\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"795e218d3f75f437\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"ef94c7657de5d3f9\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"8a9d935f178a4dee\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"5238d035e7ce32fe\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"733c49ae293d6af6\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"323c09fa34e4aa6c\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"68b39e920cf9bfb9\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"fc4a5320d4b900a7\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"87d485354ea24ff2\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"fca7069cadacab7a\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"e6a71fdb7dac3e1d\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"e2cedce0f6092745\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"2547b60984abffc8\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"839c7931d6a11e4e\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"b33886c4f712f253\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"eb60f605e4c578e8\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"e870e22b1641bc38\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"83c8cc74700f4fa9\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"1491ffc986e83ac7\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"4eb2eecb029f6363\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"5dd7d69dd31d2fb8\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"8b0768539aecefdb\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"1aa18c1bac48cb4c\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"5aa47954d7d5fb02\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"b6d998157b2f6a16\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"62c1e1c2b945731e\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"83f2ddcf1e49750d\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"6d7851b1811b3ee2\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"bbeefdb360ec8635\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"b3d69c333a6bc7df\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"4e5726cf95eb416a\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"6194b88940796a0e\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"2e07f2dd34c3cd0b\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"78ce36c653c6fcb5\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"7085367addd0986d\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"45e300b8de4a89b8\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"d18c70429ef43dda\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"9c9f6a8171f8568f\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"dea3b64f7d66c966\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"c1b0c028862a9090\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"8a2a0e9382436a48\",\"/knowledge-medium/src/data/invalidation.js\":\"696ab41eb10774c3\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"02bb8df5bfed51a8\",\"/knowledge-medium/src/data/kernelPage.js\":\"e1e5feb068cc7d73\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"b1f16be5b464f440\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"ecb63e2ad72b4cf6\",\"/knowledge-medium/src/data/localDbStorage.js\":\"9884b432237d8162\",\"/knowledge-medium/src/data/localDbVfs.js\":\"859d0bbb2500ec16\",\"/knowledge-medium/src/data/localSchema.js\":\"de80c08f1f274dbe\",\"/knowledge-medium/src/data/maintenance.js\":\"f115c889f76d4528\",\"/knowledge-medium/src/data/mergeProperties.js\":\"bb65865cca51dcc2\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"95e0b2c52375c81d\",\"/knowledge-medium/src/data/migrationsPage.js\":\"fdc7ed596f870f1e\",\"/knowledge-medium/src/data/mutators.js\":\"b705ad4d95a43e48\",\"/knowledge-medium/src/data/orderKey.js\":\"c4f05276c2554f05\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"161f45e888baaf6b\",\"/knowledge-medium/src/data/outlineSurface.js\":\"c14b36d92be810bb\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"2d94296dfa0ab23e\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"2ea965063c2a9cd8\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"6c7076771a322de8\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"0c9090d8cb02613b\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"348b13c087292953\",\"/knowledge-medium/src/data/properties.js\":\"be84caeda8a55323\",\"/knowledge-medium/src/data/propertiesPage.js\":\"cb6e61d21fb39df2\",\"/knowledge-medium/src/data/propertyChildren.js\":\"ac5660e7ce420759\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"3d3d5dbe4c2bebab\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"b1ed2d7a339a63c5\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"745180c0e203a89e\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"d7e5b061b779e194\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"586db33c2546e782\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"7f9e6959379ea7b2\",\"/knowledge-medium/src/data/propertySeeds.js\":\"8d9376eed17d9d62\",\"/knowledge-medium/src/data/recentsPage.js\":\"adb4e7bcc0930d30\",\"/knowledge-medium/src/data/referenceBlock.js\":\"20093fd9a2265561\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"38a014ab2e14ca78\",\"/knowledge-medium/src/data/repo.js\":\"a3a7d9ff30cb0257\",\"/knowledge-medium/src/data/repoProvider.js\":\"d6cf3aa7b2c6e3f3\",\"/knowledge-medium/src/data/rowProperty.js\":\"9cdfb031db374135\",\"/knowledge-medium/src/data/searchFilter.js\":\"10b013f38394f735\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"e0d530c563734a1b\",\"/knowledge-medium/src/data/stateBlocks.js\":\"ab550863ea94d9f9\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"3ccf9ac639604f75\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"b90da766f140ac86\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"3b62ba317f3cc588\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"140836063569a1d1\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"db859bf74081570a\",\"/knowledge-medium/src/data/targets.js\":\"f9ac3bd9b4f9ae8e\",\"/knowledge-medium/src/data/typeColors.js\":\"1e78ea31f5dd0b1b\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"49f84604faca6ea7\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"f2d8b7f0aa4d5a07\",\"/knowledge-medium/src/data/typeExtraction.js\":\"e6d0438c1c1e1e69\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"ea789eb4d599eb76\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"ff017bde254d9bde\",\"/knowledge-medium/src/data/typeSeeds.js\":\"2d597f2e074dca3c\",\"/knowledge-medium/src/data/typeTagger.js\":\"428e49418c901193\",\"/knowledge-medium/src/data/typedRecords.js\":\"3c8ca6635b8f6fc4\",\"/knowledge-medium/src/data/typesPage.js\":\"84841f949b9293e4\",\"/knowledge-medium/src/data/userPrefs.js\":\"238872305de6eebe\",\"/knowledge-medium/src/data/userSchemasService.js\":\"f04479a803443343\",\"/knowledge-medium/src/data/userTypesService.js\":\"bea48943a8666f11\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"c1db9a6aac7c9cba\",\"/knowledge-medium/src/data/visibleChildren.js\":\"b7b3f25ce7c49ede\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"09516dcf2f78cebb\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"789c71165895cf68\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"ef984efdd2a4a7f5\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"2fe9ea21682af974\",\"/knowledge-medium/src/data/workspaces.js\":\"c2c2ddad3e53b045\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"72b9209228d204b1\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"4cbb692243982f29\",\"/knowledge-medium/src/editor/atTrigger.js\":\"a3ecc863d6b3f798\",\"/knowledge-medium/src/editor/autocomplete.js\":\"2660a81b3fe09667\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"4c8a23c3c96b7d12\",\"/knowledge-medium/src/editor/contentFlush.js\":\"eafcac58deb7843a\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"a9fdc45341e7e8d9\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"fb05c76838dfea32\",\"/knowledge-medium/src/editor/insertImage.js\":\"82d44ee7c8867ac6\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"2e263bd2daf2d98d\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"7fecf08399ba5e70\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"af30bacabb82c258\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"9bb3a7764cb810ee\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"2ef6a5e708350e46\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"e9c8baf9426ef94a\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"b07a4dfd01417fa3\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"cdbfa0a58c6d1e14\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"7d4d43ee6ef7e3dd\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"f11650d1739bfa2f\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"94ab30c59b28bff3\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"bb01b49ad4d41ce2\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"738e83b4a44c436b\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"62297bef36535647\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"d1210b8dfbb8f7a0\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"085628fab546f439\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"5d731d31865146d6\",\"/knowledge-medium/src/extensions/core.js\":\"b449c813f1d4fbf7\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"0c31e2fb9d659203\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"ccbb5675d15610fd\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"0ec658b201310334\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"97f0da35a4a4951f\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"20b2e0dcfd238130\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"db23498856077f5f\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"61676efb81e56ed2\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"b252d1249dd90691\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"94f747e65312cec4\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"0d7c771c9550c49d\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"1956b83373a87409\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"bfd1313d9a454b3a\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"4a9c33d3d0b8f18a\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"65482e38b976eec4\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"1e6d326bcd2430b7\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"3831be313d7a462a\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"4a89f23acd3d54eb\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"f94041529ec4fe72\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"4a1dc93b790402fb\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"068767fdd295369b\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"126ee16ad68f29e9\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"cabe2d5a0121b7c2\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"83eed7ef4c7d4fab\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"3fabb41e17d185f0\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"ef59f5524f3d1397\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"9d8f016d1c25cd72\",\"/knowledge-medium/src/facets/facet.js\":\"bf0e1fb801d73ed7\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"f93283048b0ddd1d\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"17525ec178689e0b\",\"/knowledge-medium/src/facets/togglable.js\":\"0e6bc4f92f671d8c\",\"/knowledge-medium/src/facets/variantFacet.js\":\"10f7beeb9407b7e5\",\"/knowledge-medium/src/facets/verbFacet.js\":\"26e8e4ad8fe697cc\",\"/knowledge-medium/src/hooks/block.js\":\"0844d19553cfe80e\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"4cd171690efd9e80\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"ef465b78e6fdd35a\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"6c7ce672918b062f\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"7e167989c510694c\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"5a442bea2de2a6f4\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"cebd1489c5ef45cb\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"a3d09887aabd6649\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"67d48fd142f0fbbd\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"2100c9d375de0bf9\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"30e0229fb782e2c4\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"eceb398d9e3cd5ad\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"3d3d00ebbe72feb5\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"cdf35780b93ee0d3\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"8825cdf74c6ce335\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"dcebafd7a7086d13\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"7e8f0c791e95b036\",\"/knowledge-medium/src/lib/utils.js\":\"c12b587cd06ba75e\",\"/knowledge-medium/src/main.js\":\"7aff5e9a5db67a08\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"e76b4cad80dd68cb\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"35c16afa7a014f0f\",\"/knowledge-medium/src/markdown/context.js\":\"783e836d7c1b2bda\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"2516613cb1fda876\",\"/knowledge-medium/src/markdown/extensions.js\":\"2d708771e8d2e8cc\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"83d46f0145860fb8\",\"/knowledge-medium/src/minimal-editor.js\":\"642af89d7b748f4c\",\"/knowledge-medium/src/paste/armedCut.js\":\"9fcbfbdaaac7bd1e\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"b30b29894c2e9a72\",\"/knowledge-medium/src/paste/clipboard.js\":\"dff125bfd8fc9785\",\"/knowledge-medium/src/paste/decision.js\":\"dad79afbb95260a7\",\"/knowledge-medium/src/paste/operations.js\":\"d83e433613c8b696\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"730f4942903bb9f4\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"4a8168dc5eaf4187\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"30e9fa936b064c19\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"3f34d04a76ab9afa\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"926b89172045cb7e\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"f4ef7de0c63a1962\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"f3d94cc4f8242220\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"5228c0b9b64ecb39\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"cf8436313ab11d99\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"b7b4504e059e4a58\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"7a17d209c8691342\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"eabeb005ca68ecf5\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"b73dad5390caeeb8\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"5cd8ebae853b8e8b\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"3ed0ab5472528f9e\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"f289533f1ec985ab\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"58c2d809ad7a254e\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"2212f91a451e075c\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"fa022bf056469554\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"6c9d3ec31630adfe\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"5d0733a78066cc9d\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"3354de290620f17e\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"3bf2fcec79361f86\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"b3a2fd863fd31631\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"3af0ffdb2635f6ff\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"e8fa3b96b4b24c02\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"bb99e390e1310ad5\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"cd74f4380e3a3c83\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"536167e59f9ccfbe\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"e96e3ec2be46e9d5\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"a030236700b8b6da\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"ced828ce8228a6a2\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"2e823fc2da6752a2\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"01fc915efcdb5bcd\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"4e273fe3984d0e81\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"c463e55a0e3235ba\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"edd6a2bfac169bed\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"ff015a895e6d925a\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"b44b7ddad86acec6\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"ebd14f4e3647dbde\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"dac646c92d096636\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"59aabe6e20200179\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"0c4bf662384c94a8\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"2842b73e9d49f5a1\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"9123e589aa9687ec\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"da9e9bcc04784cf7\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"7b6207c888157857\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"820dfc39e6ee4b9a\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"989a6394d96b23a8\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"cc89abdd1ccb9de9\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"fb083e49ecdf36c5\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"48421d54d6d06d4f\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"59535d7c0159cb34\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"c246158749837feb\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"051851d649ebf239\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"2df6b6b1ecc71774\",\"/knowledge-medium/src/plugins/alias/index.js\":\"ff15741ce944879c\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"e2f7a765d707bc26\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"a069860d2fb8f25c\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"d6174917d2a43234\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"4ccdb40012f249c1\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"11d37fb03c20f686\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"00938937e1f0f00c\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"7d60bcf11f12a7b5\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"3210efa6e9d796fd\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"d2d1ce2bac813c37\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"9b5dc8dadefe215f\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"ed2af6e3865ea902\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"46497d5aac1943e2\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"eacffeaeafbc5749\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"176a03440c0759d4\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"8224bc2e24db5bf6\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"dd0ec9273aaa9689\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"835337e01a96c580\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"38d7e78de43f6040\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"ccca0c03162cc9b1\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"9af08fc4afb17454\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"ca19c027778012f2\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"6d2ee6a3e7239469\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"3ed16b12b9d67e88\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"3588d5a7f5d4b419\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"83b29236027df0ae\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"1313bc7545d76cd1\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"d4e1a15cf3489aae\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"98d5e4ac16f23f69\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"20eca4078dedd54a\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"c59741af51d56b03\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"fee5e65ae6b72b15\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"7d0329d00d0f8415\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"f7d630255f7709c8\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"8cab174976e9fa94\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"26e1403f14fbcee5\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"c22dcbb3e1ce9de7\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"6151ef8cb4e9b2f0\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"70d996940f824f77\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"71c51262471da084\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"46aea4bc96fa0179\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"46b2af24af06ae54\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"a5651820606d1293\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"bcc396b4fa4d0e2d\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"1c44a90339db7b8b\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"87d74f68e7a7162e\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"40aead36ed47109e\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"4ba7c5cb4a8e3d3d\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"b851f3b3c76693c0\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"a6a3e42a7117ca8e\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"6a79ab64967611ae\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"e36dc13cdb6102ee\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"6368cf670d24ea17\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"44a60305e259b8b4\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"cdf45b27a44202da\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"e1f629066c255ebe\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"b4d00ab3c36f25b0\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"d10a4b7e9042af02\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"4f179c82afc19a0b\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"94c2dc554b7ce717\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"e471f80e4d4b63f8\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"20ff2ef2490a8e9c\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"66f69bfc2f3da1fe\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"5d82a6a395ead423\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"def9ba85b05be25a\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"6c0ff6e018cf49ee\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"2fcd412553f3adbd\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"a004dadda269cc6d\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"d9d2b9097926b29f\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"806048715a0ad4b5\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"a91c73dfcbdad8e4\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"b519ce99104d59ca\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"16e78443b9a41d15\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"273799132ccdc9f6\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"7393cb715e8b780c\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"6e62f26c910eb012\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"38b42bd75371be06\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"3208a60dfb2a4201\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"f29732f7d20da686\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"ccb3261933100f00\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"6fdff495058b052e\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"cded6cc1139f9d02\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"4cd04c52e62c13f0\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"f0b5b933972272c9\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"bf24b756cecf81a5\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"73141fcff3d386a4\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"efb92c8b74b67791\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"48312e5ffa584310\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"bb973a91b8e4ed5c\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"13fab9eada66b9b4\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"fa9c06e306f29ab1\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"6561c70bfa5a2881\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"8e0000b4126e0cba\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"7fb39eb600e2b7ff\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"b7a24a509d568404\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"e453b713bf459db4\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"78ea7e17ddad2205\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"7f825a7a8e622a32\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"8df8c2fc3a959c23\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"d72be932982645d1\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"e34937f8dc1c9bbd\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"d848fe916d988c3d\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"cb46865a17488608\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"7d4cf25139a838fa\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"9fdcf5ea7457577a\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"50c4650146be373b\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"91cb1ac6e4047d21\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"888a346d6b65fba2\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"218b759a9f4943bf\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"fbe5a09a3167772b\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"b6fd2accd273dc52\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"ae9b10cbf2448d19\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"f902a64c1c3d7e9e\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"9d77884c7a56bae1\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"6957be4bea1d9440\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"b80fdd7d9e513545\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"908e3816d0befb71\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"7873fee093a16c64\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"bc855c920048d35e\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"923411b36350f14f\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"7b5bd3d9e1ec9d07\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"8e55ac2f1bb04b88\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"601b9558390c24a1\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"fbef0dd004e3bbbd\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"764e75d63aa82562\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"5307fbb5a8db3798\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"d9cd43e63b27cd32\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"8547e4fb24669be7\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"4e62a7cce5f2a6b1\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"5eea0e3eaa7a3e46\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"76d8bb94420cc59d\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"34ae44bd24a1a638\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"90e2d1ed9b1b6719\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"eecb968e277eb411\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"5e77825e32e7258a\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"b162046ad7bc3a35\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"a63a349fa69f2be0\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"1d0eca7d00879741\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"8b73f0e673102254\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"9531b08d07236517\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"d432dabbd27895f7\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"d3ffd88c43f78f4c\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"5d30de9fecfa2fb3\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"ba25e1ada4552b77\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"7059081bce926d93\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"ec8dd81346087b3f\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"b5d07f13e7c4408a\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"93ea52646ed50fd7\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"9240ac6df27c27d4\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"5857b883cd6b02b9\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"fb5887332c12d1d1\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"4c5a9aba2624eb55\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"aca0acf871344976\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"d3951e0120298fa4\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"086521505c69a00f\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"532a39e0df7943ab\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"6cbe51a45277c9b1\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"d2834737b2bb5566\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"e8c54b46803fa045\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"4f17097b7f311b8f\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"534e699211ca7e1f\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"d3c7a7d5fafdb39e\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"f760c9ae36535ae3\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"cdf056551c8b468c\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"5881504aac4a60b0\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"f5867ea852b00518\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"4755b76da75df710\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"1c82d74b472aec70\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"0f1562ce02c95da3\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"8e1c1b7b5db5f19d\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"5c170bf2dd124435\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"4871ee5c155c44c3\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"1b2dae2daf20a983\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"2cdd6d6752c57588\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"11459fcdb07164c3\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"50901bd87092fd1a\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"f9dbbce257d562c8\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"896ce07411b3e119\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"ca616cb7fc899b54\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"201e9def90612b2c\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"c12e2442c0404adc\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"1131cf041c438e57\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"819c7c7a4c816607\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"96b1016c4330eecc\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"78ef8c3b221c9dd6\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"5da64bb899a9a96e\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"602cb5b668890450\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"07282d3c1142f389\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"f95e957c4a1e0683\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"6347c4c0c26a399f\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"88c5ed251e28d072\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"d628a727ca34b57b\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"0b7da88a4f1c42a0\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"b3766351942a5f95\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"933fa78574471475\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"fe3c9edd3a6171cf\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"525bfa9d33164c01\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"93c3c9e9d6add9af\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"bd0d7c580d87c27b\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"c0c1b571cf431448\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"bfebddbce020e280\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"d1442a96ea173187\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"80292fe460c4643b\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"217ca06966762dd6\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"4a6c2336ad9d6d68\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"4b93831f6c0aa289\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"0a05cf15b5b45360\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"61058f9466c20505\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"a96cb15b4679d80e\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"3182095e7bb32a46\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"c355ed549e076467\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"683a2ffdacb184d2\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"24322395f8a2a019\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"50cd2ac692bf5ae3\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"147b9686f7928b3d\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"17211b30ae6f1589\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"f1e2d745e164911d\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"de98faab4b6fecd9\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"c09a3276c210c545\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"e2664650e5702f30\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"38ea68d1f96d99e2\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"b30e6e74e0f40086\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"20ba6f2a34f6e1fa\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"84c7dafcf9adfbcb\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"b3bb597f9a9e32dc\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"f18750d99946b047\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"17c9b78bd0c8028d\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"38809e5d546aa678\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"6afd6cd47ed57beb\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"d8277cae44c12a42\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"8494756a5c64b063\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"404b225923a50bbd\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"96badd28567ed0a1\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"0e89cd0a789a9ce2\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"04bbe7420be68d21\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"08bd1cbfaf04c641\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"e2728bcd3d96a414\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"0adcca0d9ce82d29\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"ee090a4d0ef3c077\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"d6d92df5b94e1ab6\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"e298ed3d35b4ee99\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"519f2366c8ad4e80\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"e41c3e84859e8f8d\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"849d73ba8b408fde\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"ad5877e5896a630d\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"e9a67dee5ab65913\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"eedecac483af1900\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"9b99c161cbc669a8\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"56f8f56ec52cdb47\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"915eb87e05d6b9c0\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"a2bf11a9fb3914d4\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"36c133b72c69e0e4\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"d5b4c4f1fa39ea98\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"1719a69ed8efeb52\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"d5915418fa27963a\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"8f46d56f6c97a7f8\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"c64d9770e55bd36a\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"eccd43246d3cc40b\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"c75d9d6ba0d6c84c\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"f118088c2011a027\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"07be73eddd38ec33\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"1301418bf3e043ba\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"a342ee6cee06d007\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"56e71d1f5cb7e717\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"b7fb9af3ba1e0bce\",\"/knowledge-medium/src/plugins/geo/index.js\":\"7f7ddc2e9628fb1d\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"fd55a8ffacb40ff7\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"2d1e3d61c1b36e15\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"30dd1e33501f5e7d\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"b9e4a4837afba669\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"eaf22b300e49fce2\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"ec5fc19030333e14\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"94f81e5c1c5d7d42\",\"/knowledge-medium/src/plugins/geo/query.js\":\"986e2349f7f5e2de\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"670bf588aa9edcaf\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"85598e4027bd0a44\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"67b6ed46978ec8e7\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"91725d592a8c2784\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"59f3d56d43bafe40\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"637d914a533908ae\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"08b144ac1ccbf4e1\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"b795b9b18f335f09\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"e0a18d1ee7cf9cf7\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"957bdafbd0ec71a1\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"c9ac816728406eed\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"2d24e2c11b521390\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"6fbc115f029a7e68\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"177b28f95fa4a6a8\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"7395206c0093ca02\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"22a54137d02449e0\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"e5d5631d9ec3df68\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"823d5a38aee994da\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"ab9880169c140bea\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"d56b3c2a2e1c57c5\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"5d6b95cc917025e1\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"9a6d3f517a9d12f3\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"0a504018022dccb5\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"9c04d2c66f2bc976\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"c6ca2bebb941f9bd\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"0e3d724d8d5d6d75\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"515c6e6c188fc284\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"b3e505fc2374db7a\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"4828cfab4981c8a1\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"e655747f89150d72\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"23819ae8a6bb634c\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"fd771672eee57930\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"525f52e9c39585c8\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"69ab6ff3d9b79239\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"e699338d95aeb2fb\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"152f31cd999a1c7f\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"c49f9609cf1eb899\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"c45c7d55288aaa91\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"e950f135198a90a0\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"f44e589f34f93927\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"6b3d87dcea57a643\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"1322b3608bc4e13f\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"4e3c4e2a4c2a4a05\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"e90e0d4140fe2669\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"f4c67849a744a949\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"1246e81fd9287fae\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"1fbcb39342124192\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"aec858df35e10cf9\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"58b6b11fab909532\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"1726e42200cc8d01\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"dc214e46cfbc36be\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"c87dc860b7bd7469\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"889426a23b5f276f\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"ad665cf541813a31\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"9a1c8b1118f19168\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"6dfc835155c993dd\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"ce3ea87fa41a9b5f\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"eef5f33693e9768b\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"96b7b07bb8d0d6fe\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"fda0d16809bdc110\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"6068172d84d59511\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"22d35ccacad59563\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"b3e55ceeb83cad37\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"7f734655e5c41a0a\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"e27dd1a8dc7d7ad1\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"dfad400d1d646f08\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"de2fc1e93ceea4b3\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"abf3433d2f552988\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"96a9619e924f5fc3\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"c4ee18d68c03cf47\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"d150b6b838063b97\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"27abb76284ac55d3\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"5bda6238ee55ff23\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"a1d93876d98e3745\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"b85a6432bed88db1\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"23bfe4f41bb3f184\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"834cbf3ea9d9be51\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"d53ed031ca744c2b\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"24919f1d3a78d1fc\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"3bdbff893ffccf62\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"5090db63f0b59157\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"583c46b642932784\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"0b5c28d9eb37d903\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"63577bf43a679d77\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"ef84cad0e6828850\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"b9b847983f6d6d4e\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"73cb763d36adb7da\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"78f39e4931d40e83\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"bc0d70a67c5dad77\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"00847946d41c5ee7\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"5662d768adde77a3\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"d5e71d8ff99dc351\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"5601f0add76c9418\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"956d5f9a35e53a93\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"2d004be62df99c39\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"12c1a1266e0167b7\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"6cb4a2dce810135c\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"59ea00f1ccfa6f57\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"7e96d2b9d618a3cb\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"1598df5064544f57\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"43e3d503acf67cb3\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"fe95bdc94777704d\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"a11f32353f745b4c\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"067d5025ce966004\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"249d61947601d9be\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"430f91650fa89e7c\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"1a0a27ffe777988d\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"4e7aca371cc71e70\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"05c0fdb33383162f\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"c79fb0d4a6d2b129\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"c3c48104f3d2d19b\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"ed460363d7286458\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"7980b48ec264fc5d\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"fa5e844eb3564ab7\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"95b3e9ebb71a9294\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"b67630de2b620351\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"6c06d44ed509509a\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"09bc45d28fc5d44d\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"c2cb4cc6dc9135f7\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"0ac6e44f4383e92f\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"977543c54de40c05\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"f90f038836ead0a2\",\"/knowledge-medium/src/plugins/recents/index.js\":\"493e8bcdc8b6087d\",\"/knowledge-medium/src/plugins/recents/target.js\":\"87623092adce7016\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"71049eea34e3b269\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"80656935235962eb\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"ab53b68eee917ef7\",\"/knowledge-medium/src/plugins/references/index.js\":\"a6a38fba9ca3f6c8\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"b6f70f2748152626\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"477be6e77542a7db\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"cce822a4593082fc\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"3f295fb030a0023f\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"3e74391693dfff45\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"479d827246fae0b2\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"c993c14a7bffafe8\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"9f829534b855416e\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"7b5851585a694580\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"5da802d1599d74cc\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"f9078ffcb6203815\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"c3405b6f43f6c356\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"074935a4b72dacfa\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"46ceda0744f2adb1\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"5f2ef1884d872c66\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"4f98b9957cb44d7b\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"6014362c8c64f04e\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"aca622078a080b23\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"b0903114f87a5c8d\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"a3add13e8cb5832b\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"4b86844ce957ea95\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"d0f229bbb3bf13a5\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"451d4b034559cab6\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"0a4b1dd9908b02d6\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"f6cac5ca59cca11f\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"8dd51e0ff21b85f2\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"9c68305f9e956114\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"5fd26c272f73c58a\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"607a246a73aba8e9\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"ca26fb5ad52d5d5d\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"605eb67ff3fd7468\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"e9b67b4bd6244a9c\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"77197ec0147ef0eb\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"3a6322c861c0b23d\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"39b38c82dcb54b2f\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"0c48600f20b70ca1\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"1c463ca3d5e81491\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"74d89f3fab749f62\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"29c8fdbbd00f8303\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"34d053002acd3733\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"e205f165e971e369\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"9439031ff07271ef\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"2b0e7b55cd784f6d\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"5390b2487a3dd9c9\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"1804a178b6f2cb07\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"868ce593dffdcea9\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"b73eb4771811acf5\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"1b28c787465bb4d5\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"40ac5bb9cee9ef28\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"f765e3af2b899d3f\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"a6a952b4cbe83f60\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"7a8cf44a6e01711c\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"f03bf34ff86c2b1b\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"299e82b7b1cceb4a\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"861c3a6a0135f4ba\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"7efdc2a405ce3e6b\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"bf352659f63c3caf\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"eb7160131fced7dc\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"6c2d048e4d9dc11d\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"49c97ac2a2993aae\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"d4164507bdadbf48\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"6015540a1d673ec6\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"dcff4234aaffe056\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"a38d90f60f1441d4\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"998498a13310a134\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"e79b2a4a6d7d7aaa\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"16c748774d1271aa\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"b22f5eb7dedb3de1\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"fcc49a646ad803d5\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"dae4e94ce217779c\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"8e2bf7000fd53572\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"2a0cc46c60fbf904\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"0ded5efee984409e\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"2d708b5dd64ec976\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"cd3bdc06a8b290d6\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"59501dc503821e57\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"d6726e250cf61e5b\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"2e441b5204182dca\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"3b5eb14754e86464\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"d1a99aaeb913e04b\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"819dd3fd2d7f93e1\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"2b4d40af4be025b6\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"f52bf4e39df22f84\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"f453119025290e23\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"0ea0be8b02c77ab1\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"b32f206f0990e08d\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"b233ec70efd21a85\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"3fdfcd6077fe5f7c\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"834bbc0d66f7d9f8\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"d5896d58c0d114b0\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"e438f599f9b74dd3\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"3686329b31f48bd6\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"f2f335403a1a816b\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"d516d5456894141b\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"68c2c2ab16f96592\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"7be0349c65b64f49\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"9cd71477e460d040\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"0d9c45503e964159\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"bbf9e18cc3c30955\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"dd92da7812d0c448\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"19049aab9a28ab9b\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"b4a1ca80ca0541ed\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"7ec30136bfcf7140\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"e14c2bcfa145ae03\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"1cfa860e1d9f983b\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"eb620e874be3481e\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"eaf9bbceb23673ca\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"54274917a85c211e\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"f164f864413d3ace\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"8201d6fd005997e4\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"34340b2cc902074f\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"a11a840508fea791\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"d70c1b5b7c334f91\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"e27f3c42ffd1d9c4\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"ab58843db80991bc\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"c37e9ca9691f4dea\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"2e8b88f463fd241c\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"4ae9d36d037f7f48\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"e6998e8c6fdfcb4f\",\"/knowledge-medium/src/plugins/todo/index.js\":\"fbd9c50babe9a44f\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"ac87934aa0b795c8\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"b057158d78f18577\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"0d721546433ddefe\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"e7969ac644b42993\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"0731a99d877028eb\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"d7b80d4683f59748\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"ae3e9c7067573277\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"28731dd50007725e\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"5eeffcb4810afaea\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"4ef97e444c123a5d\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"afca8faa97485ce2\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"17bddcf75ffe29d9\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"9a7d0dddfab414e9\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"1fd8985511d25dd2\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"47d947516484dc71\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"4bb63e0209fc861d\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"5a16bf2f0258aa28\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"db6ff8927bb609ee\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"a4628c56260e966c\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"a13d7a7b85ced5a6\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"23456a9b1c166147\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"92e1d5587c371d30\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"1982294131edc982\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"0800b0cd170588d1\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"b8ac0117229740ce\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"159606c6ee940b58\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"96f3020b1b7f63f6\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"176626ee0296c571\",\"/knowledge-medium/src/registerServiceWorker.js\":\"9bc78a3c70c053c5\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"79c0a3e8a925c7ca\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"c10cf8e10955a390\",\"/knowledge-medium/src/services/powersync.js\":\"cf4d66c11f1c829f\",\"/knowledge-medium/src/services/supabase.js\":\"aeba1eb85ad719a2\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"8c613ca9f4b5f43e\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"36f0f3cfd17eedae\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"871ee51fc45fcbb8\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"4518d682cca39c49\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"6ece84353167156c\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"feab775a072dba14\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"14ef29cc6db60eb2\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"30e546c319739db2\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"3aab9f11ae8ee54d\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"f0f94d29aab7fa10\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"c12eba7a3e1a51b5\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"39a0fff05e8674b2\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"19b2a010bda34196\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"f4de9d6ed509b249\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"0b3fbc40f375ebbe\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"7c74b4f38981fafa\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"3ef8245307c6a861\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"d6d924a5f42f992e\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"847b47e478b6597f\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"111561b60f65b311\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"8c5478cb3bf03ab8\",\"/knowledge-medium/src/shortcuts/types.js\":\"89b888ea6502809a\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"f6282660722f8c41\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"f5d49fed84f515b8\",\"/knowledge-medium/src/shortcuts/utils.js\":\"9a09e37fb82541a5\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"5f7fa2511e6c9a35\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"8879177cf86db69f\",\"/knowledge-medium/src/sync/byteTransform.js\":\"26399b8a06c0785e\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"67ef508a45a98656\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"fe1fdfe878ad0aa0\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"5a7a250b5b53bbec\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"d81011c9d44e6203\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"b4f7f598de71f7c1\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"c98d07d5ac4f8824\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"4dbd2d58007e79a3\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"96685c95044efba1\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"06ee3a10e591b367\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"c3a56788fcd6958a\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"a0108a353a483bd8\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"f7198cf2acd6cfd9\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"1df416bce4200893\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"0fbdb7d9460f0770\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"ae6e6db18a111e03\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"4a0c24cac54a707a\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"4665c0175d99186b\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"d37602c511504afc\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"b16c6a3da4836f37\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"35d852493381d549\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"03d8c351ab0097a6\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"f1def72311c7b7f3\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"d259b3a333799dd9\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"fc162ddc06100cc9\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"20385e8b2d37bc0d\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"6a287f0af77104c5\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"ea9d66c1cf07c0cf\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"d95450ee6e36a91e\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"4786499a5d01e5d2\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"6c7c285b931f6e41\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"916d2c673555813f\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"4b8275aa369d457c\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"545467c15bfe404f\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"361c25b51f51b4d5\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"7003a3dae25f135c\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"03bbae4e5b137ff7\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"f5d509bd148a7db6\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"4aaa09c3c6b3a654\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"c07d87c76990cf54\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"1a0a8b7521393754\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"dc8e8a19c1ed3565\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"6cc58973d17d6fd8\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"ba8e6ccf1880e0ad\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"9a496cd3b02ca1c8\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"bc8ad961c511101f\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"58615ca64b56a5cf\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"25aa3b368aee630d\",\"/knowledge-medium/src/sync/transform.js\":\"c3ea7881811bb71b\",\"/knowledge-medium/src/themeBootDefaults.js\":\"d0a11e7ce975f950\",\"/knowledge-medium/src/types.js\":\"b863f9710af14724\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"82da8acadfcdba34\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"4c24e319ea58b7fa\",\"/knowledge-medium/src/utils/array.js\":\"3e8406fdd2599fd2\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"8bdbecfba79d7369\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"e3ad0da788d94a7b\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"fae7197050f2f524\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"b0133b24d4374935\",\"/knowledge-medium/src/utils/callbackSet.js\":\"531fed828e9959db\",\"/knowledge-medium/src/utils/clientId.js\":\"6c03dd85a6ee8bb5\",\"/knowledge-medium/src/utils/codemirror.js\":\"b1e1b858eeaec4fa\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"9e6a085ec1c283db\",\"/knowledge-medium/src/utils/copy.js\":\"b812efd808a2595d\",\"/knowledge-medium/src/utils/dailyPage.js\":\"e77ef2db003f9071\",\"/knowledge-medium/src/utils/dbForensics.js\":\"b15b753951c32bd3\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"e5d7ca92af921b66\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"0c6864cd43942a44\",\"/knowledge-medium/src/utils/dialogs.js\":\"d6a784f9ca500524\",\"/knowledge-medium/src/utils/dom.js\":\"705a5508493e6e56\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"609cb0e6f349479b\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"4d3d7c564bec2430\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"14a32f532f729ac9\",\"/knowledge-medium/src/utils/flipSlide.js\":\"a0fd0c40de4a6aa0\",\"/knowledge-medium/src/utils/fnv1a.js\":\"4abbac8c1d34bc41\",\"/knowledge-medium/src/utils/formatBytes.js\":\"7138829837dc6c8d\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"3a3312570b7be4ff\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"2f1e78c844116c36\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"3f02fef97b400862\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"6bce2e1ee993dd79\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"1f4f41a1a89439cd\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"9c82f20a8e4ccb39\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"066f2c56382af770\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"014c0974624dcbb2\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"548ceaf100ec610f\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"fbefcb8eda8caced\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"bcbd014a7cbdd0cd\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"90b985a0e16b9aa1\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"cf6d36c41b88e598\",\"/knowledge-medium/src/utils/markdownParser.js\":\"355a8f1c663aeed7\",\"/knowledge-medium/src/utils/memoize.js\":\"b159db127747ce36\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"e1c08422923f01f9\",\"/knowledge-medium/src/utils/nameList.js\":\"7e279a314520f48e\",\"/knowledge-medium/src/utils/navigation.js\":\"7ec84dc50aed20cb\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"4dd680806cd902ca\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"c984561bb39e7f83\",\"/knowledge-medium/src/utils/panelClearance.js\":\"dc81de2ed1ed86c8\",\"/knowledge-medium/src/utils/panelHistory.js\":\"322c4c71ad4cc507\",\"/knowledge-medium/src/utils/panelLanes.js\":\"343d64bed7c5700d\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"ac041ff79e741b22\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"d60e5bc9787362b6\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"c675aad06c8a93cf\",\"/knowledge-medium/src/utils/platform.js\":\"55416fc16b34f137\",\"/knowledge-medium/src/utils/pluralize.js\":\"0fb0204d094d76d8\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"ed32c0857adfd1a3\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"90a56f0cd1c973eb\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"5f80214724c38806\",\"/knowledge-medium/src/utils/react.js\":\"2cd99fc0fa1331d2\",\"/knowledge-medium/src/utils/relativeDate.js\":\"bdbc084da44dd934\",\"/knowledge-medium/src/utils/relativeTime.js\":\"a2035a3d07ead5a1\",\"/knowledge-medium/src/utils/renderScope.js\":\"57ce19ddc6783e35\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"be1caa20c6cc4d3c\",\"/knowledge-medium/src/utils/routing.js\":\"dd71b79c47396149\",\"/knowledge-medium/src/utils/safeMode.js\":\"eac7a80997ecef98\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"fb0f5f0be1800dd6\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"98ccabf0aebb559a\",\"/knowledge-medium/src/utils/selection.js\":\"f6084d22bd4a245b\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"6522f61d67e4880d\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"e9f734634f257003\",\"/knowledge-medium/src/utils/state.js\":\"a59c371dd81599cd\",\"/knowledge-medium/src/utils/string.js\":\"2f529713af2abbb8\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"007dab1b444cf21b\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"7297ff3caf2f8520\",\"/knowledge-medium/src/utils/toast.js\":\"b46187c159261283\",\"/knowledge-medium/src/utils/toggleStore.js\":\"e8a097d7aac93f53\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"40bb81f552056723\",\"/knowledge-medium/src/utils/userActivity.js\":\"b044590d9c27a756\",\"/knowledge-medium/src/utils/viewTransition.js\":\"64f01dbbb196db79\",\"/knowledge-medium/src/utils/viewport.js\":\"e62a4b197d2be6c7\",\"/knowledge-medium/src/utils/webLock.js\":\"a52a47e4d43dc2a3\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"9390f02cb52ace83\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"124d693caa4fcaa6\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"6f1ff53f74700cf5\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"18903a031b273b82\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"981a5b4fbfbded34\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"0c1a98d21c121619\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"84d7db247d82b501\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"624e4bf9f472fcfb\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"523212fafb9ed0a8\",\"/knowledge-medium/src/vendor/react-dom.js\":\"1313170e70f1a7b5\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"c29f50a750a826ce\",\"/knowledge-medium/src/vendor/react.js\":\"a4f45774551a8a3f\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
