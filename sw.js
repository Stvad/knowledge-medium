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
		buildId: "010f2c2fa9bb-554b0a7d",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"524e7eca3929ebb6\",\"/knowledge-medium/index.html\":\"524e7eca3929ebb6\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"efa6fa564f31bb51\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-CwFJT_ra.js\":\"871ff86aa4d4ae18\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"2ea9020acdc5853b\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-BCVQqo-c.js\":\"23af0aa63763f939\",\"/knowledge-medium/chunks/FacadeVFS-B3KGXOHN.js\":\"b5527f820182b866\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-DmEKXebh.js\":\"275d1437d55d6e55\",\"/knowledge-medium/chunks/MemoryVFS-C2un1kBN.js\":\"3c2019eebac3cd40\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-B446CTQq.js\":\"15f18f57a1e6b32b\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-DgxJ9nEV.js\":\"0cdeed1c26e31c4c\",\"/knowledge-medium/chunks/Preview-BxRv7GVb.js\":\"c8a0dd23fd02dbfa\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-DR1jSTTq.js\":\"d8e1389f0dac6194\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-DUlWy6Vs.js\":\"e4523358ecd1b23c\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-BUHBXp4c.js\":\"a291fc4cf41c9f87\",\"/knowledge-medium/chunks/react-BmxBDDNb.js\":\"7d7cdcb7b8af24e8\",\"/knowledge-medium/chunks/react-Bn9KPyaD.js\":\"1d7ef79c75f8b8cc\",\"/knowledge-medium/chunks/react-CqYVOEb5.js\":\"a3fa54d77526f0d9\",\"/knowledge-medium/chunks/react-DHuDbCDP.js\":\"45b0907f12794578\",\"/knowledge-medium/chunks/react-DabfiJ6C.js\":\"ae39592caaef604a\",\"/knowledge-medium/chunks/react-Dr2kOqF8.js\":\"7d710bf70b5b62a1\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-RAD-dwhk.js\":\"b3bb3e3d6f1bae3c\",\"/knowledge-medium/chunks/react-dom-server.browser.production-8TwWarpZ.js\":\"aa6ae6441184da16\",\"/knowledge-medium/chunks/react-dom-server.edge.production-DqHznkQF.js\":\"fe318e86ecb45582\",\"/knowledge-medium/chunks/react-imd5YxTP.js\":\"d02669a95e43f287\",\"/knowledge-medium/chunks/server.browser-Dv_nMpsN.js\":\"42461f0b05528c2e\",\"/knowledge-medium/chunks/textarea-BykiNtKJ.js\":\"9cc256d0d12fa925\",\"/knowledge-medium/chunks/ui-BfF9ZPvL.js\":\"ca4a7097a61abb3f\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"87f7dd066d8b86fb\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"30d9414baa17b101\",\"/knowledge-medium/src/appUpdate.js\":\"b4a219f0fad665dd\",\"/knowledge-medium/src/appVersion.js\":\"6fc893230ab64136\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"1690d132dc5b845b\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"f852579628338824\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"4da0e9cffebba9a6\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"d53fb44be897c753\",\"/knowledge-medium/src/components/BlockComponent.js\":\"e57e9a5e7a4667ef\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"38cc5779e1b1b12f\",\"/knowledge-medium/src/components/BlockEditor.js\":\"d3556e6757fc90c2\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"a40f37c5eb49b74b\",\"/knowledge-medium/src/components/BlockProperties.js\":\"f4bdac7a29eabc96\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"20f825ef78fb8f12\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"38ee7e57b465cc42\",\"/knowledge-medium/src/components/DividerHandle.js\":\"30a450ba54cc1028\",\"/knowledge-medium/src/components/DraftEditor.js\":\"dd170e98c4b22346\",\"/knowledge-medium/src/components/GutterPill.js\":\"cdb5520ec4039dd7\",\"/knowledge-medium/src/components/Header.js\":\"07156fa0d8c8356e\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"41812b0449343cff\",\"/knowledge-medium/src/components/Login.js\":\"8b1280bdf02fb7a7\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"8c7b5396e994244a\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"4e2d803442fcdb28\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"2ecb956ee50b6631\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"afe95aec6abf97c2\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"385408ca6055f785\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"31dbd0c7595c0d8b\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"6bd3889267f2f6c0\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"ac5a1eba8e5b382b\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"e5f6d2b17a6737c6\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"12783fe004d9cb66\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"406cda8f2fa5ea6c\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"ea7eef401c990a3e\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"37d012324ea75208\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"6bb45e0657350a55\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"492ae91c5340921f\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"01561c3cb35141b5\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"81cf98fda58420f1\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"ee79dfff4b910ecc\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"32ff33ca4fab1231\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"35f04e0ba11bd692\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"7a2c11ff5559c45e\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"4fca0dc6a2686e9a\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"b16bcbca9fa33850\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"be7014218786408e\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"4e55cea7e777dbf1\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"494d7340a5d81117\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"ff6035156faa60e2\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"bc45b956d177a796\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"791f31718229bd40\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"2fe5361e195bcc83\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"9090b66822acbcc2\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"a5e6bfb060940fcf\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"a2e53ce6ab1adbb6\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"922d13b3518fa9b9\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"371fbce101932519\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"ecb4c098ab938477\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"57f3093453b18965\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"cf96835ccc711012\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"96efc054c29a104b\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"ab3cd04c1ce9a02e\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"f2adeba39b7f06b1\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"14eca3b7c30184a5\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"d7fa960ab3151bac\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"83370935c7ee0945\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"5c0027929c4eae07\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"80d6ae2d5a9fa000\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"925e8ffdfa167095\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"47873da186cb2335\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"f2bb378c9c4aeccd\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"bdb22dc9a06d11bf\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"e937b5e317ad77b1\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"d7a9f31e3091a23d\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"754e4181439e1f52\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"cadaa1114cfdd178\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"f202202c81068c97\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"35ce8557f16293be\",\"/knowledge-medium/src/components/ui/button.js\":\"e7fc262b2803ac3d\",\"/knowledge-medium/src/components/ui/card.js\":\"040a2ff2ff02ec58\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"72973eacc5b85a22\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"c4c1e391f2a4d144\",\"/knowledge-medium/src/components/ui/command.js\":\"0363c29e9483e838\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"45d97d227460204f\",\"/knowledge-medium/src/components/ui/dialog.js\":\"bf01b3748e06fc3d\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"23ed37306060d9a4\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"29075abd6ee507ab\",\"/knowledge-medium/src/components/ui/index.js\":\"23aa48632c1ac4ac\",\"/knowledge-medium/src/components/ui/input.js\":\"57ffead9eb2d7ab3\",\"/knowledge-medium/src/components/ui/kbd.js\":\"388f441b8c426254\",\"/knowledge-medium/src/components/ui/label.js\":\"62b9634685836337\",\"/knowledge-medium/src/components/ui/textarea.js\":\"489347a69cb76365\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"5687505f9b9e3b3b\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"0fba9952f3e84aa6\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"bdff03cf72b6da01\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"62a997cae7a32474\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"91b1d40dda98bfd5\",\"/knowledge-medium/src/components/util/error.js\":\"2cf0d586a181599d\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"dfb17ddc250fdb2a\",\"/knowledge-medium/src/components/util/suspense.js\":\"3b7ff458907f3d42\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"235751412f132a53\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"aee395edd7ff2077\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"cedef421cdead0d3\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"e7c3501928165a98\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"de4dfc1c924e5a2e\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"ed8c11eda8c20524\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"41f73475307ebd34\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"135fa9125628facb\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"31f1f8a2413ba1e4\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"16d0ef9c8661ad16\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"c0c3c01110501dae\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"22b8f02d34f683a2\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"717579f827a1c5d6\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"698db40148dec68a\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"c3f992584d791880\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"e102b7e5af9eaaba\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"1327d1658085dfa0\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"515a9aa84848a162\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"d1ebb92f891c0210\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"648e33bfccbb2be5\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"0c1ae5b281cdc92f\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"583f1f990efd6387\",\"/knowledge-medium/src/context/block.js\":\"309209851e648061\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"eb680cad2cbfb35a\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"38123fbb12f29a49\",\"/knowledge-medium/src/context/repo.js\":\"05558ce7a7141d05\",\"/knowledge-medium/src/data/aliasClaim.js\":\"78f353ae4ae4148a\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"b3a01e8839b2f526\",\"/knowledge-medium/src/data/api/blockData.js\":\"14a2cd0483636526\",\"/knowledge-medium/src/data/api/blockType.js\":\"933499dce8c1a2ef\",\"/knowledge-medium/src/data/api/changeScope.js\":\"5a8d378c23d59a39\",\"/knowledge-medium/src/data/api/codecs.js\":\"8608be7d6765d56b\",\"/knowledge-medium/src/data/api/derivedData.js\":\"f964349b059f4b11\",\"/knowledge-medium/src/data/api/errors.js\":\"1c49f809024742dd\",\"/knowledge-medium/src/data/api/events.js\":\"2c4ad887c5e4bd76\",\"/knowledge-medium/src/data/api/handle.js\":\"07f5c77dc103acd5\",\"/knowledge-medium/src/data/api/index.js\":\"6b7aefee98784c81\",\"/knowledge-medium/src/data/api/mutator.js\":\"cc8cea6dc0899226\",\"/knowledge-medium/src/data/api/processor.js\":\"8a700bceb79f6257\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"31b394a567c879cd\",\"/knowledge-medium/src/data/api/query.js\":\"f097687f078ba1b4\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"9c6dbfc414311241\",\"/knowledge-medium/src/data/api/schema.js\":\"07f5c77dc103acd5\",\"/knowledge-medium/src/data/api/tx.js\":\"07f5c77dc103acd5\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"916a086d5b01c5dd\",\"/knowledge-medium/src/data/api/user.js\":\"0fda69107743a61d\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"01dd275b90c0b126\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"e0c6077eff3dcece\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"7655b5a29bffce5c\",\"/knowledge-medium/src/data/block.js\":\"cd41cf5a615f6135\",\"/knowledge-medium/src/data/blockCache.js\":\"4ba1c15dc140ac12\",\"/knowledge-medium/src/data/blockId.js\":\"1e9aa80ff460c4a0\",\"/knowledge-medium/src/data/blockLiveness.js\":\"ace358bc88f0b274\",\"/knowledge-medium/src/data/blockMerge.js\":\"29934f5fa88e8eea\",\"/knowledge-medium/src/data/blockSchema.js\":\"555fdcbd2b02b558\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"2ac0cda2ea94ad2f\",\"/knowledge-medium/src/data/blockTypes.js\":\"a96165c689e450bd\",\"/knowledge-medium/src/data/clientContext.js\":\"84f243da9828a9e7\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"37eb5ba5bfc8117f\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"67dd67db63e518fa\",\"/knowledge-medium/src/data/derivedIds.js\":\"b3129366dbd2ea2c\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"abf18831336c64fa\",\"/knowledge-medium/src/data/facetBridge.js\":\"260963f48e2aa9d1\",\"/knowledge-medium/src/data/facets.js\":\"99f029290f93afd8\",\"/knowledge-medium/src/data/globalState.js\":\"5312ddab79db0d1e\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"7a966ebfbf0eb30e\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"8b6ab3c8ee6bd55c\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"0891890957962e4d\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"bd75711414d1dc1c\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"23cfe2424ec06848\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"ca62f31caaaba5f6\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"8ea987a9b4ef4c5d\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"66cb31efd8a31e29\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"892e8dd6314a1e25\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"c92b25b53a5ff71d\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"946c463fe1a55bed\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"806bf750535921d4\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"45ea5e696dd42fca\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"67c263a62c9be91f\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"ec980a9d6e8f8a41\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"8db0e1f3e0695fa7\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"ad63ac509ea16a97\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"ea5d3804b8cca6b3\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"ec7e0d629f760d84\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"93c9db26533e2b1b\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"1b91372b7c229eed\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"4307a4515c78a1f2\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"ddca6c0fdbfc499c\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"16133f4ba1022dbf\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"0cc922e8fab5fad2\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"636ee6b51efdee67\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"6108ddf071fa8368\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"a99ff95f205c8d09\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"c03077f30755fbcf\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"02f38364345eb2a6\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"d79b65302961e1ee\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"f99aeefca83f89e6\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"ed6c5ee937c7e861\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"ec5938f59c010580\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"11411351cc8800c8\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"400d03d173a7c2a5\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"da6522b43fb1a314\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"5c4a665c53bcfff2\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"a26bf9cd0e81d9bb\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"2e5d268149bde0fa\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"5231200ef051fec2\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"8ad794605608c3e9\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"7a0be3fc0608dae9\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"d46deb5551a14ec5\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"cab38a413b79d902\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"9d9c5565e85d56c5\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"5c5fda942b66fce1\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"d179102de4defc40\",\"/knowledge-medium/src/data/invalidation.js\":\"18f42a9debcefb0a\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"ffe6516d72033cac\",\"/knowledge-medium/src/data/kernelPage.js\":\"4c488be147413d03\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"43f7e70af049ba7a\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"55c324d0637257a1\",\"/knowledge-medium/src/data/localDbStorage.js\":\"f56591205a7dbb4c\",\"/knowledge-medium/src/data/localDbVfs.js\":\"8cda25c13d98e384\",\"/knowledge-medium/src/data/localSchema.js\":\"8a2a08f1d57d35b5\",\"/knowledge-medium/src/data/maintenance.js\":\"13deaab064175d40\",\"/knowledge-medium/src/data/mergeProperties.js\":\"82ffd80dde272eb7\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"ac9778d4feacfd89\",\"/knowledge-medium/src/data/migrationsPage.js\":\"7b4ee06a570f9e25\",\"/knowledge-medium/src/data/mutators.js\":\"721fc3f7cf1d1703\",\"/knowledge-medium/src/data/orderKey.js\":\"bd7b31fa04a35426\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"6081c7680cc9f04d\",\"/knowledge-medium/src/data/outlineSurface.js\":\"a4fe1763e02ea40f\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"e035da8644467624\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"56605647f6706563\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"867ee4e556ae41cc\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"0f66e306b8e4180a\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"20e7b250de53ff6c\",\"/knowledge-medium/src/data/properties.js\":\"c3bac4a828558350\",\"/knowledge-medium/src/data/propertiesPage.js\":\"2445002de2be8e81\",\"/knowledge-medium/src/data/propertyChildren.js\":\"5a2928c3b92d69c1\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"36569ffbf3fec671\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"8ea6a2edd4fa79d7\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"ff42b4a5f0ad83eb\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"67cb58e1841c4be9\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"5ebd425b0039815a\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"d035126992a52563\",\"/knowledge-medium/src/data/propertySeeds.js\":\"a47a3b4553e1d08d\",\"/knowledge-medium/src/data/recentsPage.js\":\"5ba9c93eda3a162c\",\"/knowledge-medium/src/data/referenceBlock.js\":\"ab667b6ac9b350cf\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"30a600e5e9d732a1\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"1f4a921c0bde5fb5\",\"/knowledge-medium/src/data/repo.js\":\"d5633c013af817d5\",\"/knowledge-medium/src/data/repoProvider.js\":\"6287cadc4f2c73cf\",\"/knowledge-medium/src/data/rowProperty.js\":\"1baa0bdc8c90c97c\",\"/knowledge-medium/src/data/searchFilter.js\":\"b91c0562d771419d\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"0d6d4aa0e41efa72\",\"/knowledge-medium/src/data/stateBlocks.js\":\"85dc54c97e1a43bb\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"2ce3969d5bfaca60\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"cfa6c4f1f31a0130\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"46ba7a7755e7dfb6\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"e9af1f0b2a6913ea\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"210ab62c7c60c344\",\"/knowledge-medium/src/data/targets.js\":\"a9b5a73de97eec84\",\"/knowledge-medium/src/data/typeColors.js\":\"91d89aa217a507d2\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"1acf75092e6c4de9\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"800163eb8bd8e21a\",\"/knowledge-medium/src/data/typeExtraction.js\":\"84ddf05e300733c8\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"795a2f409baff145\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"fcc9c038808e3fa8\",\"/knowledge-medium/src/data/typeSeeds.js\":\"d736470fb2fae420\",\"/knowledge-medium/src/data/typeTagger.js\":\"c288939ceb65932d\",\"/knowledge-medium/src/data/typedRecords.js\":\"c16d5f3cd8d71499\",\"/knowledge-medium/src/data/typesPage.js\":\"9c563e91bfcef066\",\"/knowledge-medium/src/data/userPrefs.js\":\"02b828db0ba89026\",\"/knowledge-medium/src/data/userSchemasService.js\":\"20783456ee33af20\",\"/knowledge-medium/src/data/userTypesService.js\":\"76e72537bb115561\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"6ac649cb910e0482\",\"/knowledge-medium/src/data/visibleChildren.js\":\"f6c95505d9ecac4e\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"d6fafd023f559953\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"2979e0a8a509447e\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"bc86ea39dc2fcd21\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"6bc46989b6419caf\",\"/knowledge-medium/src/data/workspaces.js\":\"8debd6515f001316\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"b8719de2b8763dda\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"7005b3297e888fc4\",\"/knowledge-medium/src/editor/atTrigger.js\":\"a7d8e4e38ce00815\",\"/knowledge-medium/src/editor/autocomplete.js\":\"d4e38b1950f8bf0e\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"a1f7246bfddabac0\",\"/knowledge-medium/src/editor/contentFlush.js\":\"78c2d0af76cd9751\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"f652c597e4b7163c\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"98e9e67487b889a5\",\"/knowledge-medium/src/editor/insertImage.js\":\"ca3506986495de99\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"43eb685005232a51\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"76a1bb5267c8d129\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"cc01bc44036a1696\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"37d67fc4c47d661e\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"ef14ad5dc4e0ac10\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"493122a105feb0f9\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"c8016c94e6ab9b89\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"f5735f9f94abdb89\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"022e7eedfc41be24\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"f01e52f4379040aa\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"b45ab5a958fc4857\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"bb21e1928e073110\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"fdf3e6ca2269e7f4\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"d50b9a962407cb99\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"222c4550b54318fa\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"d81c3694ece249c5\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"a65338511bc202e3\",\"/knowledge-medium/src/extensions/core.js\":\"ce13545aba23d765\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"036ea4f33372fea9\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"aa265b754c8b9e84\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"e073d597ca4a29eb\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"b10087bb723e7eb3\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"7545924e4f12a2ed\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"e0789c4287b7fa7f\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"c306d349406b2996\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"a546971a9800d13d\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"2b69aa3baac58845\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"18ce4ba1a088790b\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"d3eea01360bacb9e\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"6a4cb1189165ef2e\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"502fba29f399fcb5\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"9ab2f1499d28888e\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"e3ed5580743ae9e9\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"81ed94f985a682a3\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"4de894deacc5668c\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"7289f0383b9fba35\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"d7937496b8c7e8fb\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"c93539ba299cc96b\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"cef6d6a62eb7e0a5\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"755d29536c536fd9\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"0b6d0e9ac75fa194\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"b8144d127ce28a30\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"38fab0c8f54db99d\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"f4ef6ca77d287aa8\",\"/knowledge-medium/src/facets/facet.js\":\"a9477e72e7c70bd3\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"f2cd7700c0f04fab\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"64272b538a4aa1a6\",\"/knowledge-medium/src/facets/togglable.js\":\"fac457d1916d6bdb\",\"/knowledge-medium/src/facets/variantFacet.js\":\"3bcbc563aa8ff15c\",\"/knowledge-medium/src/facets/verbFacet.js\":\"242019739cc0346f\",\"/knowledge-medium/src/hooks/block.js\":\"28c48ddf79efd8ce\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"da1477b73c5ae9ac\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"0d383def01c5c7bf\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"a638498b7473d1b0\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"81fc67fe7d67d0bd\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"268855000c86a051\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"f092859c5db77fbb\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"8ed361261eb9d869\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"bd07aa365cc019cc\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"8ca5d5e4810df48f\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"410a55d251c250ba\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"8bd35f099f6e6210\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"df6ddeaca2fa4023\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"c2b1cb90e4b8ee82\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"f5e7637bf6f32d8b\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"1b03407a8b5fae9d\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"f09c85c7110840fc\",\"/knowledge-medium/src/lib/utils.js\":\"ceca5dd810602ba5\",\"/knowledge-medium/src/main.js\":\"a386225eefcfd28a\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"477f3540a3b94a1a\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"2cd91449d9a7f848\",\"/knowledge-medium/src/markdown/context.js\":\"e4e8c7a428f3f496\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"3b2f5d2466781a5d\",\"/knowledge-medium/src/markdown/extensions.js\":\"55341b3927b65e14\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"98dc1e4c7d14ea6b\",\"/knowledge-medium/src/minimal-editor.js\":\"09cbc41f0befb8cf\",\"/knowledge-medium/src/paste/armedCut.js\":\"fb432157b8c13185\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"75b159fa9ec4879f\",\"/knowledge-medium/src/paste/clipboard.js\":\"1a3b60e8e907d60c\",\"/knowledge-medium/src/paste/decision.js\":\"5ea791be1f3a5c3f\",\"/knowledge-medium/src/paste/operations.js\":\"32b7cd9b483c258d\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"ef5eb3f6009818ce\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"b5b0851978e30ada\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"b037f815ddfcc065\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"a86f6e586b3def10\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"cffcdf780479b566\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"b5d8698559451c6d\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"f01e66a2bde7cee5\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"964e004aab88fbf5\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"a916c6ec42935e93\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"d76f71c4515ce555\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"924da0d075889bff\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"09c83d79df0dfacb\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"fed31fd1e799488b\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"055d6f8975fa0453\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"efda2d7aca2f64e6\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"e367f6267578fb36\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"4051bda757dc3370\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"6ecb72def4b840a7\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"f9035c3a2c574e3c\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"8ed39c09d70211cd\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"10357297832b0bb2\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"ddf14ffe31e1a5de\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"2d98c333a1bdea5f\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"a41cc99ac3f2777c\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"7691a3c2596ddbf1\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"8b1f9d78b8097e6b\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"15d6d22c526e017e\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"458967adc3b3a9ad\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"a3a04f72249d5968\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"613703b9d25b4b88\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"11d09af32f59cc1f\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"a8a6a2c84f60e0ef\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"9b209b8eacdd66a6\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"82579b7405755fd7\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"99ec6a517082fd17\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"7b9ed2ed54a3c4b9\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"c2092d0bb9b2902b\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"05bd95b871581323\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"9a276c890df90b35\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"8a8b10b9839859c5\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"79831ffbcf5ad6eb\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"1b157e05e7ecc426\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"bb10390a0eaa3f1d\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"1ede62084d068aa3\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"fce964c5852b703f\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"72ca2e96ed2f5344\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"6224bb8ea67bf214\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"aa6814bb6ffd01c5\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"9ae1440dd966addb\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"24f59463a81fa176\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"c70472d5be8ef940\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"0e61fb9a2e22b98c\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"9c7ec11a8a2c34eb\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"beb0a44430a6c958\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"e4c0d9f32a15e73b\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"53b98db19a464dc3\",\"/knowledge-medium/src/plugins/alias/index.js\":\"62920b8666bc666f\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"a008b206d1354c76\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"c1a3408119f19d1c\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"b687b32d5e3cff65\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"7b96f3cfdf4ca437\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"65692309b2709955\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"9ebd3bc9ae8dd0e1\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"f2015b420d124f9f\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"562621966b18ba9f\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"5dee3dc17b7af87b\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"5d214e1599af1af8\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"fadfcf393e0ea375\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"aef7e0bfa31b8371\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"367618ca58b5fbd5\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"9a441b0da0cf8608\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"f76cddf1499fd34f\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"a146e67304b95f3e\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"5f9138b515c38242\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"a0714f70ec410ace\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"1aaa1f5c2e0a3cd5\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"457a87343d6104e8\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"83170871c176b8cc\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"469a0f5b2a39d085\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"53386c0dab5e28c9\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"e32c3b3f0394bb06\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"e740c7af4619cc0f\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"0d35e15b5cbce22c\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"8422a7b18290a726\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"c15a13410f784f7c\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"339abd889d361b8f\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"478551039fd51cb9\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"c39ee82f1803aa75\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"b6d6626c301f1130\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"1ba712283106b85e\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"24adc5cf657e05d3\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"a88ad767d0647252\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"8495cf80a81697d5\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"cbb4ef449e499674\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"302b353dad68b1ed\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"933ab35b51f14989\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"cb5171f11710a75e\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"8ca4de33f3ddc9ed\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"50d5ada5a7c7ad0f\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"08e5525519843f48\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"4cb40146eb2562a2\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"659869a4807ac64d\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"fbc08342c8c70ae2\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"20e73cb890efeb34\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"5cb19c09ba536eba\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"b94a92ab5fb93162\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"a0f7c71b91edc4b6\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"2fbd062a2d23d028\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"52626b10093c81f4\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"ebc2a49ab04cc308\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"5f6562d44c701439\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"60122714cf9bec32\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"b9678bda540d6a58\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"41ee996bc90ca44a\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"010fb2ee3f3d8989\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"3c72ce356af432e4\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"5f3acd8842dfe6d7\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"cf260f3c724c441b\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"2aeac1ca166c5df4\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"ee1fdd67c75af3ba\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"f5c3c98e794fc62f\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"20d53dfc0b156c07\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"b96a24d9cb5047f2\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"9c4664969804b034\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"939ea6f845a75fec\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"3311f899e17d7256\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"9ec7e035e29a8175\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"4e2e8c6c92b3a363\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"14e1924a3ae711db\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"0f17337b59935ad4\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"95e59eb3ab38fa56\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"86f911fc90d299f9\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"af2926f6047f7a2b\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"1dc159877265a9a1\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"faad5aa210b62a0a\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"333f48f8bb5c9b39\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"3f5d0800239f6982\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"3a300a41050f32df\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"fe8b595bd9583f82\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"ab187647265de84c\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"7a631e33f5a6473f\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"d1d71a27382be452\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"1bd1455230beef0d\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"55c87fdf7a509748\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"d5c97a057651fb87\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"96ff11191a64295c\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"5627913b90b4e8a4\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"b648101559536121\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"cc27f9d4544621e2\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"da5f29e37831e9b0\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"abdf5199fe499d9e\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"3fbd56ee6ac803b3\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"bb992b90b04afc65\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"1dda618388b7141f\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"0964e24905579d21\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"ed034107c4987af6\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"daa0f12bc95adf28\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"e284d6a3bb464df3\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"a02cc8efa4d4f18a\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"a994dbdbc6600b10\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"e2889b77e4fabbe6\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"f4a859bbb407d777\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"2579ca76cf0998d0\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"539a78eb8d4d071e\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"db377721fd1bfb5b\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"38db4fcd6f7683d6\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"09d10534ab59c670\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"f26854acedbaf7f8\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"0484da13343758d0\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"8f272d400b9eaee1\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"fda5c888384271ff\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"f81a79fd7819896f\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"bb153cb7bad4dde0\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"66280e57f4ae6d51\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"bece115f049e3b29\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"d05cd0e7a5a8b367\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"7f53c1a55fcb16d4\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"1111aff67e3019bb\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"16410128328ecab8\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"2e2e54a37513d693\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"4ae1b3be57eb4425\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"b984900e9c658293\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"d7a22d880ebf3e1b\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"907c745da5268cd5\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"dfd5c1b8e00bf640\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"e914b580c93a64b4\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"d1e556e38a63fa07\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"14a95660a256b2c3\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"dcf4a98a193e2b96\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"a1c77ffb8dee8ca6\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"28ec0a6d64b4d790\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"8ba013ad56f68d91\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"bf019ce44c169d07\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"b00d7dbc1c85126a\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"cd7e8050e433f62f\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"6b0ed49a94d26893\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"e7b80b5fb4316a11\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"c7509ac123cea3fb\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"ada63041668e117f\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"3ba141ec216122fc\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"1b61c695d6904c7b\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"441043a0a9095806\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"af964f014c77a53a\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"12c6469f024ea9d7\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"6b5046296c43a7de\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"e99294da01c82a51\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"d7d7836cd9d1635b\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"ed93c8bb8160f891\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"bc6abb10609a4399\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"2104d5937bd77c9d\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"47979ecb08ca154c\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"46f0421627732309\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"e8c59ab1e8af7885\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"8c5a7fa7b295d700\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"37bab6e1874a86a6\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"02fccbaf07695b9a\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"66a2dad59aa09f01\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"8267721b3be948bc\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"648024fc9cbbe1a0\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"3fa22a96b44821fb\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"0309fea6953f90b4\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"8a38e693b11ebfe8\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"79b7e4954e404978\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"bc988fb4e493c868\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"af21c89fe2f63ba5\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"45fb7bf21b198b5c\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"09fd5f10f903f1ad\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"8c7564e91380f7ed\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"a5daf6b821e691ee\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"7caa3740493fd663\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"27eb58a7bc945595\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"16a4a48bb9f7b9d9\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"47a71081814fce86\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"80d90dafdc22df28\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"04d85d996992504b\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"e5f2ccb4ac21e1ba\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"e3b0b45ebb5d9655\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"826de8bcf54e4968\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"43860508bda01f7e\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"e35756f0291e68f9\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"911341ea8625803b\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"7743be5b10e69e58\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"f491e7db0da39602\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"6637907a56713a07\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"126bb6d034467f75\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"a5214b493310ca93\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"6e76e6aa3d7ca69d\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"bb16a8fc4a785b23\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"2e49c71bad01b4c3\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"224f04436c37e0fa\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"2ea8efe3f917e74c\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"64399d69dad5b5e0\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"f871e62746f8063f\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"02b24b9401d8e98d\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"5b6a7a07cb2a98c7\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"5fd2cd5f6ca54d94\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"97263f294a4880ff\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"46c4b75fc7e3616a\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"b4bc28b870fe02db\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"0d049c6759909563\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"d8569e0f7cb0c4ec\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"c10ad26d08ce60ff\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"d857f20c9b8c9c7d\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"540d4fdccb1f6345\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"17fd19622a9c8f3e\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"06ce9f414bd49b4d\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"1f9b47d85ab7a0e5\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"f290f3e540f47f96\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"84450390fd842426\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"aeaa03fd1b08c1c3\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"e28fab9225666417\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"7bbfbe3a65d70b4a\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"60c1d749a304ed9f\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"0cc277056126aa2b\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"3e009a8870f89a6c\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"5548d11669e6f99b\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"e7a931079bd5a28d\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"897a4e584ecf0f2e\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"273c83e14783185e\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"4c1f2ad2b2f4760c\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"e08dd2948b6183dc\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"f1feb6cc6df0aa8f\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"04064d3c0a33050a\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"c176718358b832c2\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"d9adc0beb3a1768a\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"ce8dc817c657c1bb\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"1141f42e819425af\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"15ea53f213ee4352\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"381c01936d643e34\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"a5a81e3bdd246873\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"53af72e56a016987\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"64766ed929d813e5\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"a55351bb7d4f0443\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"423949fe3451b7a2\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"86e9509bd9a44dfb\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"fea87eb9ffd80e6d\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"16631e61110c6f45\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"d13c2cb03f7ce961\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"174a89c3f4f87743\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"e398ed0bd8ee188d\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"f45db3436c0ac417\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"98b90c0a5855e619\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"e11945e5fdcd0e07\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"32d8de866c225bc9\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"6d1e741dadc1b647\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"cc9a6f5cc1e580fd\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"777df1ffccd593c5\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"eee89b83024a7de4\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"c0b6220637778dcd\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"55fef0d5c9806cb3\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"ad0d9fbcf04183a0\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"d0407eabec556256\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"b5a25361b135bb7c\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"aa6d531bf74491ca\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"c0065a62e04c0fe5\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"77b00c6af31ea312\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"d9df6d23ef45c340\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"1f717d18a2962c12\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"0567c0d59a87216f\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"eb44670ee096ed3a\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"7aac1c77e143466b\",\"/knowledge-medium/src/plugins/geo/index.js\":\"c16e12fc33e1a2d5\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"029c8086f0dfb7ef\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"8d6eec1ae19675cb\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"fc77c19669bdd510\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"83b9688b5ca7026a\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"9e13f2ef53a06337\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"a2bf3b128d6255f7\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"d434307aa42bada0\",\"/knowledge-medium/src/plugins/geo/query.js\":\"4fa2e96ab6da3697\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"11fa6e14945ed931\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"bb394677662bc152\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"f4775624d362433f\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"86b3d2a328eeb6ae\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"85f86dba6fcdb114\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"960d5156637c95fa\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"8c5d539836d25fb1\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"0665ce224d455d31\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"8d5282556cc531be\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"406af0abb8c79933\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"ad991542023436eb\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"a6708f7beef8d08e\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"5ccef19acb60dc2b\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"a0d225b17351a991\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"2fdd627e31e85196\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"bdb1c670e2fe9376\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"2829d1c14a04be59\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"a079931b88b886a4\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"6cdfc9a6766d70f3\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"46272c0021c11b50\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"5f8b0fdfb65ea6e3\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"51f898b01503399f\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"5d44ba9e4f6acb9c\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"a69ae7edf9abd3bc\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"a1150bc484c785f1\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"759e199e8572855a\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"79b316de469bdf79\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"4c95ddafb5b8698b\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"d015be55ead6766e\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"3e3f38b127a57232\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"9c5dc330d82d4eb6\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"c7b947b9b35bd057\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"e94e542b7b43f491\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"b1c359457444a1b2\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"0379d8193d251730\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"99780acbc027f634\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"e5701be818e47d24\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"ee4acf8d4eb0eb18\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"9ac8779cead9c8ee\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"4165b6461aa5d4a6\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"f3ab626e0baf11b9\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"647814c98f0f0c81\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"d51c80f3fc968aa5\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"a41a3d1be8cc3b31\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"64c2510cd242314e\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"5487d2379806a7e0\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"50ec718c2a8f92c8\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"dc744fd1ba2ae9ea\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"2e7c60fb5a52b380\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"2b1f8fe97043ad59\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"a8d274f2e93ea152\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"7bd462ddf030152a\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"e53c56aa2ce67d9c\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"942db318c2a5a02b\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"0f0b7d810445713b\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"5f7da943c5ef6253\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"919bc50ef024dd37\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"13d7a66bb851763e\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"d88f214cf34c24bf\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"39882e22c6625816\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"172bb98450fb987a\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"90ee5aa252d81766\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"1d158ff44d03ae33\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"000ad4ede1724208\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"eca935809cd63ec6\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"b9526cb008f09441\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"78902509349cb254\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"fc04a6f640eac241\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"df330a2ccba4232d\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"e385b7da335c0c7f\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"93c81386d0f5eac6\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"93e8f3364987475b\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"549151846ecb6074\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"71bd71fdc5733e12\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"0f83d0ed3696db4c\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"a7d96b7d6b6eaec2\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"71cbff1f65587348\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"20e9cbc98f32b285\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"aaa89abbaedea2f3\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"ad35e686daea565e\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"641e36cf01210365\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"44b5f3f8d06d23c3\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"1586b009d6922689\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"1a5e8cd17e3e6320\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"9894dec5d1ccfb72\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"bd6d5d00ffe9f1a2\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"033c64532826b79b\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"169c0e6a07c13ea1\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"9feb132c5e0eff3d\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"f61ad2a0c6ecb600\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"3581effc35db2bc9\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"b6210d7cedf3c391\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"304cf372159de2ee\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"0005b37b164ad5a5\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"5a7c37cd406cbaae\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"2bcebc5c1aea8e3f\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"83ea20707661ead0\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"a5e404942a1a9812\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"5281c264453a1fa5\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"b5b962e4e6aca1fe\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"d3fea186476d8f9a\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"044da91576910b05\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"243084a97b073c67\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"5c33f504ee57d066\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"a14ba3cc9537bb26\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"0dfaec83a3133b7d\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"6e1a78bff64d58d4\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"c444035d50653388\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"a29b04c1eed89a33\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"9ef1ae865aded697\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"91b02db67a296504\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"137b38f1d4f63c18\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"7953db87937a0945\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"d47e3553ee03ef04\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"3b02d3b2030e25fd\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"68b1bf2d4fa9b388\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"d3aa780647b71711\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"4e1603f33999a762\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"59bfee67f309b257\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"903b9f42fd7452ca\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"14e60d41456fc46f\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"30ae2353c4b76913\",\"/knowledge-medium/src/plugins/recents/index.js\":\"39378a956aa82f8f\",\"/knowledge-medium/src/plugins/recents/target.js\":\"b00133506fca90ac\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"a9ed7b186ee6a2c2\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"345537e5567c5e2e\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"01ff821fdce9feac\",\"/knowledge-medium/src/plugins/references/index.js\":\"e1698ef0b82a9781\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"68bc051d1770de0c\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"088ce1b94a174f29\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"d6cb243a3d72edb3\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"bea25171aa702523\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"50d21df7743cf504\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"5b97e112828f5d54\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"25d1001e4fdb8e8e\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"c37d635e3daa6d34\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"5fe9710a92671061\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"853d1f91b05a2c59\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"13a3a3eb2e438c65\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"642936fd5a63ac8d\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"c5f345c6e9d4a3c5\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"688dc9471dd2759c\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"d2ab5522b705753f\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"e2a6ffa70d598de6\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"66ec1382409fb7bb\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"df77fee21f6873dd\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"87104951bea707cb\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"cdaa1f547a2aa955\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"60258d5f034888df\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"98a08e8961a1ce6c\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"83f1e178801a1199\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"6d257d93f95d47a3\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"b68fb057473b01bc\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"4cb292c7e8e2d7eb\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"ae2cbd1263ee2a3a\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"53a0df94056561f3\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"4232bece69ce284b\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"5b1248a5ca0dd3f9\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"2269545336e9c057\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"059b03f973df312c\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"7c4b3913c83b7d4e\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"9f19258df196b25d\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"8a51923efb33c877\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"5154aa359c022b28\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"0363c4d83608afce\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"3e90178be1b70820\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"b2ac64002a79d0b4\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"6842b5e68a5a75ee\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"8e7162061dd2b120\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"29857b91b2715c97\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"125823767d806db4\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"7e3b3038ad01b1a6\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"5dff389b342a9236\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"2c8d8eaaf0055810\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"a91dc760264fe147\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"7a40c48c7e2ed0e9\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"0b09dce2f29d2d89\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"41ff3c0f962882af\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"33a4b55183b9f4a4\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"10e2f17b730415cf\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"edec59dc045246f3\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"95372448f63da3fc\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"d2ac748d9b92aa97\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"4c299a88f33f7bbc\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"f40e4e6a9cfa1f7a\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"0add3087d0dc6486\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"3cbaf8c29af9380b\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"373c8294140ea73a\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"3c3abfdfd15cb59b\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"974af9ecfaf6507b\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"4e9b93a0e655f344\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"4a8628db501cc501\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"3fc1188d27c0d366\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"db3217566ee8f9cb\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"8e179999b497fcc7\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"66be25be585af83a\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"af61768fcffdddbd\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"db7a11923a17b222\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"f840c02e8541e1c5\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"6a980d3acc393315\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"fe853ae0402cdfd4\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"6142160de7c8d8d6\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"7588eb95535665bd\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"53553904d6db9562\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"56913ea694d7e09e\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"aadd61530701dc2c\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"a30f2c433bb2741e\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"798e0918ca28204d\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"2d47f70a1ce43bb5\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"a9bf2b8cb0cdfe00\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"9f7f12f0144df394\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"a68a481fe58fa7aa\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"e3764968fa5cfcdd\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"c0c791b6725fd678\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"b3c9880fbc05b828\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"5c159ea915bb908b\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"5983b1ad8eda8a89\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"b51af704e74ba042\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"a5b0ce0388193d1c\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"b4129215de9fd761\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"270808fc433c4029\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"bbd7de9eb8c30b3b\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"00d840cbad619457\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"ebe355035b49ab87\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"32dfcb7c6f829d1e\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"8068aac5fc47b790\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"8a8a641b2be3fa31\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"e843c8f8fad7044f\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"896d13d9d637712d\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"0b35864e6e28f5e1\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"22cead392674bd47\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"288982db3183ee6a\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"78d52e91cb1c8867\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"7e043fc580faa220\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"003fe944adce2d3c\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"e10b8066c082cc9b\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"d80896c207cd124b\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"f7fe261e78f02ee0\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"df9c1a27ed90787b\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"27394d5492046f1e\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"88dd902a157e8bfe\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"e355c41fa724b61c\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"787a275ecf97cc7d\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"8b0db3fd47a93607\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"41f750cfa083c961\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"8c90846d527612d6\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"86a6bb129473c81c\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"6ed8c2958782b202\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"7dbd7e98cc03590e\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"0226c164168cdcf8\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"a83636cc57a29170\",\"/knowledge-medium/src/plugins/tables/index.js\":\"f42244971590579e\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"9a1275ad17cc6f7b\",\"/knowledge-medium/src/plugins/tables/model.js\":\"6e0d1ae36016e735\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"ee157eaf66bded92\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"1fe3ac2326052201\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"b25d8cbf5713b1de\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"de6313e88a3eef96\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"db649375005d5a7d\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"b74ad701af1a3830\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"1c7379837ac94543\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"d133e8f3d4f2e417\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"3591b59c03af84ab\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"669cbdc1fcd15ad0\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"b13da3971c9b1c57\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"390b9ecc86d4a73d\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"b1b70569b19bb64f\",\"/knowledge-medium/src/plugins/todo/index.js\":\"b16ea9ae87f3e17f\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"af1cdc83573d444e\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"9dbd4e520f399513\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"edad73352d1305d9\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"3ea1173f4ac5e79b\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"a8a85c88307c5817\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"10c367fd3d652107\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"bed6fbf7afb0c1e0\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"876b5f83283d8772\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"2fdb7d16a5285bb2\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"1c4d531a7649b4ca\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"5bd35df8bb076410\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"23a7a72343e42d82\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"770ea7831ad0b724\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"d9cc84f0c64f668f\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"e4b556c0c137ac86\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"a03ed27163ba5983\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"fe1e098deb84d49a\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"23fa88c830864122\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"c80aed978a2037a3\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"64074c29ff05ab46\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"84d4994ce0a650ac\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"bdc9a97e430942cb\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"93f50454212a3549\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"f0eb7784f3006c5d\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"4894674ff5487256\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"849d95e268622bed\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"67f29ef0e7e34319\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"4c0952ec0248ca47\",\"/knowledge-medium/src/registerServiceWorker.js\":\"7c1f97146231a767\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"ebb29942413be272\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"fabc5874c8353d81\",\"/knowledge-medium/src/services/authStorage.js\":\"4d4aff310b829fc5\",\"/knowledge-medium/src/services/powersync.js\":\"f7ce3345f5994095\",\"/knowledge-medium/src/services/supabase.js\":\"0b671546af0a4275\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"81a52140b7ab485f\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"59aee496f5c0e731\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"a9c7bb8cb012ccb2\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"bafa9af5edddc3bc\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"ecc11c165c5baaef\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"78ac9296d2c39f42\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"d67ca4ea2cbbbb72\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"d8371084cc035efa\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"8d83434dd121b0ac\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"fa98ea511d1b64e6\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"abfa934cc4c43777\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"540f878130067f96\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"6677464f60b6eca8\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"01fab703c4826c8e\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"e42386d5b9778423\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"c0954b944237c15e\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"aa1f73c393563468\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"6c85b3fb1d4510bd\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"02896907cc846976\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"94853a8a98bc572e\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"13a996882dea6d80\",\"/knowledge-medium/src/shortcuts/types.js\":\"e43a8bf684eb9bca\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"dbb24115caec8ebf\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"15339b501a5dfe6e\",\"/knowledge-medium/src/shortcuts/utils.js\":\"043a91c77ded9dfe\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"04df270a7da41d79\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"8953fc85c2d4972f\",\"/knowledge-medium/src/sync/byteTransform.js\":\"65a3f4e4526dad07\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"7984e7e6cc788178\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"a308c463f8127c99\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"13972f5d09b488a7\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"5e3ce850f6c156d2\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"7144850c5d34530c\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"d03853f3b7632ae1\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"ed71a842ae830722\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"e3bf83061a52d92c\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"202155e28c38b774\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"39bf6153aa32ed6b\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"523cf80d029421e8\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"d21911baf82cc286\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"61db839f62076319\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"23b3540cf318c34e\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"d7bf6ef20f3e89b2\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"3d208aec9bf7f259\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"8cddead306772849\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"1cecf592044d42ad\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"b43d36f6195d9d26\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"8d4823ead3c030da\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"f0ec914d3de24c87\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"f5c90f70f5018c01\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"e4471fc70cbfbec1\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"ba874e914f5cef33\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"b57917331847df45\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"acb6c85cda1ae8b4\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"0a23df1236069ba8\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"ac3d6a282e08f1cd\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"d29a93ee76521b7d\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"245ac932ecc6a4c9\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"d0f276eecdb079a5\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"8c85d85e74a13964\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"26dd9bbcf4b691d7\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"d4ed7ca050080369\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"6b2976beba37efd7\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"9f310285f48be17c\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"0306fd9e4f5185bc\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"e2c45fe2447d9856\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"2c84004a15f70ff2\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"64f5e0549ae7ef8b\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"f96ff9d13e4db2c7\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"1ed00ee14c057bf3\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"210948b97ec7659b\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"cd23822462bef8eb\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"d3a2fefbbff3891c\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"a11eb50aaf458a57\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"fefa8c8d3e9ce72d\",\"/knowledge-medium/src/sync/transform.js\":\"26b4114f5bbd808d\",\"/knowledge-medium/src/themeBootDefaults.js\":\"89e6ac25890aa797\",\"/knowledge-medium/src/types.js\":\"695f39774311bdce\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"0d242d0504416f00\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"896b458a06ef7b7e\",\"/knowledge-medium/src/utils/array.js\":\"2227ecd5ea118a30\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"70aa49397b7e4bad\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"82f9efcc18df4750\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"1e60b33fceee92a9\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"a36a13018e1fd72c\",\"/knowledge-medium/src/utils/callbackSet.js\":\"f162f8a580bedd3e\",\"/knowledge-medium/src/utils/clientId.js\":\"2d57a3936898543e\",\"/knowledge-medium/src/utils/codemirror.js\":\"9f36803582f8972d\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"61bcf8c7a0dc7a8e\",\"/knowledge-medium/src/utils/copy.js\":\"3742ea9d84fce661\",\"/knowledge-medium/src/utils/dailyPage.js\":\"fe1a320fc3c8950c\",\"/knowledge-medium/src/utils/dbForensics.js\":\"214e5ef280250eb0\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"a4c2150d3996cb49\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"23646d6aa87d4066\",\"/knowledge-medium/src/utils/dialogs.js\":\"ea45a470928ead9b\",\"/knowledge-medium/src/utils/dom.js\":\"d8562c998bb6127d\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"6a802ade95b2f05e\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"a55203fc1f0f9540\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"abd8556fa2d78ac1\",\"/knowledge-medium/src/utils/flipSlide.js\":\"66c5326da50cfc66\",\"/knowledge-medium/src/utils/fnv1a.js\":\"93281daf2939724f\",\"/knowledge-medium/src/utils/formatBytes.js\":\"ecbe9c4afc1c82da\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"ea7d1547ed70e362\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"cbb796d45897e465\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"53b5d957216fcb39\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"591cd12f2ba96cb1\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"1143e827637300b8\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"1b38ae5d940e125a\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"a48d4d192ccfa277\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"857eac701221d748\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"7fcdf588286a5bbb\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"f42e3954b632cd3f\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"4c4e9955a7469e4a\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"385a587f709b10fa\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"ea8f32b1769ef202\",\"/knowledge-medium/src/utils/markdownParser.js\":\"c4c2e708de1a2cb7\",\"/knowledge-medium/src/utils/memoize.js\":\"846422086d37799d\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"95bde6b2afd4f4d2\",\"/knowledge-medium/src/utils/nameList.js\":\"cfbf60d2f025d536\",\"/knowledge-medium/src/utils/navigation.js\":\"e5082ac4aac9e040\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"a16d318f273d63f7\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"72cf5438d59f54ff\",\"/knowledge-medium/src/utils/panelClearance.js\":\"95d5e0c42908b3f6\",\"/knowledge-medium/src/utils/panelHistory.js\":\"43fa098935b3bf1f\",\"/knowledge-medium/src/utils/panelLanes.js\":\"6c341f7d502cbc09\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"a81600885bd22011\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"4ff736363215867b\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"9c35d2556707aa6f\",\"/knowledge-medium/src/utils/platform.js\":\"a6ebc00299947b6a\",\"/knowledge-medium/src/utils/pluralize.js\":\"150e351f766e7a0f\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"7273d418db0b5efa\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"27389349f76ef03c\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"5a4a98699ce251c3\",\"/knowledge-medium/src/utils/react.js\":\"63a8b4a1d5bbd34b\",\"/knowledge-medium/src/utils/relativeDate.js\":\"fd11cb26b91bfa8b\",\"/knowledge-medium/src/utils/relativeTime.js\":\"8d434640d1892074\",\"/knowledge-medium/src/utils/renderScope.js\":\"7609e7b9e88c2a27\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"0e200de95fd93413\",\"/knowledge-medium/src/utils/routing.js\":\"479d802dc7d36c9a\",\"/knowledge-medium/src/utils/safeMode.js\":\"3be5d15863db1423\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"72099c76d9c4384f\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"253b016ccee97944\",\"/knowledge-medium/src/utils/selection.js\":\"65c4fd6640c38c49\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"7565c57f26934f14\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"a1c85ee2b319fb85\",\"/knowledge-medium/src/utils/state.js\":\"a1d0149ffa08c165\",\"/knowledge-medium/src/utils/string.js\":\"70b12869dab95f1b\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"fc628dc0da2c2f4a\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"b9779cdb782ee819\",\"/knowledge-medium/src/utils/toast.js\":\"67777511a2fb5294\",\"/knowledge-medium/src/utils/toggleStore.js\":\"f9339ccf1db51f62\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"71b6b172faeba5c2\",\"/knowledge-medium/src/utils/userActivity.js\":\"2f42768c2eaf28b8\",\"/knowledge-medium/src/utils/viewTransition.js\":\"b4ec701d5eb3e261\",\"/knowledge-medium/src/utils/viewport.js\":\"d265cd03979c4eaa\",\"/knowledge-medium/src/utils/webLock.js\":\"42164ca59506e875\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"bc7ca0fd5c1be464\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"8d16584128894236\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"c0d742ed683820a9\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"dcc173dc54b59811\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"b2ea3fa8da1a5317\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"09276566424ac477\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"9d9b2b00919cbd9f\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"ec55832021515be0\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"fc186327bdcb1ba9\",\"/knowledge-medium/src/vendor/react-dom.js\":\"5ffa32e489747eda\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"75a49954b87bd43b\",\"/knowledge-medium/src/vendor/react.js\":\"6f808fd34fbc5d2f\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
