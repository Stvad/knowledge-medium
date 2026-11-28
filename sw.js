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
		buildId: "7f18abe92d9d-e9430609",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"48afcd23583ba70c\",\"/knowledge-medium/index.html\":\"48afcd23583ba70c\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-BuBJY6nT.js\":\"f498af828dfe4bea\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"0f787bdf923a340d\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-D_Whxo_G.js\":\"91cb8c3b77e1b640\",\"/knowledge-medium/chunks/FacadeVFS-D9gtLztP.js\":\"ac2e77007228c756\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-98Y4XPsg.js\":\"e7a4b0330a45ad13\",\"/knowledge-medium/chunks/MemoryVFS-B4WPOwXA.js\":\"d0ce38373d29c71a\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-BB4CWaNw.js\":\"aa1d716a26856fb6\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-IdpyiOcG.js\":\"3860fcca0978b262\",\"/knowledge-medium/chunks/Preview-DSAx3vVu.js\":\"874e9f6496dcd5f2\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-B_RhK4yT.js\":\"2500c2c1dbe6c384\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-tMDjc5zz.js\":\"07da9c1fc8f3aaef\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-B3QQXZln.js\":\"716d8f66fe5f32c2\",\"/knowledge-medium/chunks/react-BoNWGFTL.js\":\"da747946fb4a35cd\",\"/knowledge-medium/chunks/react-CBPVjV3Q.js\":\"226038b4586fa683\",\"/knowledge-medium/chunks/react-CHuU-UPe.js\":\"68819029a6d11f4e\",\"/knowledge-medium/chunks/react-CVuC126g.js\":\"ff315c745d552a94\",\"/knowledge-medium/chunks/react-D1Q9AASb.js\":\"fdb8f3cc95d5e7bd\",\"/knowledge-medium/chunks/react-DgKEv_AT.js\":\"a68c4463230c41c8\",\"/knowledge-medium/chunks/react-OSzt6da9.js\":\"8292782743773769\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-DTVqwKDK.js\":\"3d010493f1c73603\",\"/knowledge-medium/chunks/react-dom-server.browser.production-hxkdSxs2.js\":\"dbc94e44521441e4\",\"/knowledge-medium/chunks/react-dom-server.edge.production-BYYPVAW9.js\":\"0b5544bb8c73c0a4\",\"/knowledge-medium/chunks/server.browser-DrvDV2AI.js\":\"ddd6b0f2014dad42\",\"/knowledge-medium/chunks/textarea-Ce4CYV2s.js\":\"8b8b791248cba593\",\"/knowledge-medium/chunks/ui-DKlzfEBr.js\":\"f1c18cddc7c5687b\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"e537536175cc6619\",\"/knowledge-medium/src/appUpdate.js\":\"eae48de35ea89dcf\",\"/knowledge-medium/src/appVersion.js\":\"79fb464643f015d5\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"6a603923c5e5cf7f\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"ca2294e1f1d47b9d\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"d1310621100c6a7f\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"f12fd055a51c6388\",\"/knowledge-medium/src/components/BlockComponent.js\":\"f4548a6a47ca4e48\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"88a0564c76aa14dc\",\"/knowledge-medium/src/components/BlockEditor.js\":\"a25d42537fb9ac5f\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"97e49f0b3102c3f6\",\"/knowledge-medium/src/components/BlockProperties.js\":\"5a978fbf7ec8a0ea\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"53ed561471556a76\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"d32afab7822923ab\",\"/knowledge-medium/src/components/DividerHandle.js\":\"7680fb40b718a141\",\"/knowledge-medium/src/components/DraftEditor.js\":\"80dedd3786a25d7a\",\"/knowledge-medium/src/components/GutterPill.js\":\"ed715aa15ac20081\",\"/knowledge-medium/src/components/Header.js\":\"faa0fc9ca6e668f0\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"1d24987f04a0274c\",\"/knowledge-medium/src/components/Login.js\":\"dcaf0abd875f801f\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"889138728295fb60\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"007408e9d94e9ca4\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"0b28a99f65311727\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"200db01b16789203\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"cb68f547c520ae0d\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"0fbe5ec80cb985bc\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"9f7faa1213f7998c\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"bf309cddbd3a1acf\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"26d4c2af4e32949e\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"2da03eb435a816cf\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"8d402487fd473eef\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"04e8ca00f314b96c\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"6cea900581b6b2eb\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"e7eb05ef21f08d61\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"537e9b654a9f5edb\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"e4e480aabf4ac4a9\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"ab2a099617501361\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"10314fe7892c4d23\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"3f2e05a1171e4289\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"dd5e4b7d8055383c\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"ae4d71e524ff3090\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"bf2509f02bba1e57\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"bd29a988588eca5a\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"0ee392f096f5210e\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"4f03b088a0a7c266\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"a6c1c0bef56d59eb\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"fba268940a0845cc\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"ed29d0ec51518868\",\"/knowledge-medium/src/components/references/CompactReferenceLink.js\":\"23c6013b15d74032\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"693903de912f441b\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"4e18998987a4f99f\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"d90abdc93bfa8640\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"2d95cdc4fc8c27eb\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"a6a5f84c1a391f6c\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"ee1cf6638f8d7785\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"c0b6a3d7b24707ec\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"ea78576892dd7bf2\",\"/knowledge-medium/src/components/renderer/BlockReadText.js\":\"a4a4bc0ca5d3489d\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"68a24102983d892f\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"f3fb6aa98dfc010d\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"0c5c5c9827daaf52\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"0a5c4f7cd5ae50d5\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"e9cf439f5ed71aa8\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"5f2030aade92575b\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"537078bee007d58e\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"1fb4cff8ed118e94\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"a6d1a74509ba1d30\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"0e9418de3e8a69c9\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"87a17af9d79c6cf3\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"1045f98857305686\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"10cabdf578e973c4\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"09ca2ebf08cbdbdb\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"430affde4064ac53\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"49b3fe8e2e4a78c5\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"0ad017f60f6da88f\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"35f8d1d53555c9c9\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"94a69afcc3b87088\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"007883fa2cce34dc\",\"/knowledge-medium/src/components/ui/button.js\":\"57ac0efc27a0e8f8\",\"/knowledge-medium/src/components/ui/card.js\":\"e486c1ceaf701f35\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"f5503942055d437a\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"0f121037d05b402a\",\"/knowledge-medium/src/components/ui/command.js\":\"882ca9adaba487f3\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"1f17c29eb34b6763\",\"/knowledge-medium/src/components/ui/dialog.js\":\"a91c91e5470bca32\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"57e09835a4a53c7a\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"1c7c2d8419741a86\",\"/knowledge-medium/src/components/ui/index.js\":\"62ff0dd29b24aaf1\",\"/knowledge-medium/src/components/ui/input.js\":\"e216d40ecb4f06a4\",\"/knowledge-medium/src/components/ui/kbd.js\":\"b156a91357528dca\",\"/knowledge-medium/src/components/ui/label.js\":\"ed0adc681224d354\",\"/knowledge-medium/src/components/ui/textarea.js\":\"259cc77b9329e240\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"df24181a80bb8f2d\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"5fb9b94b326d142a\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"714ba96aa588a38f\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"3e74b502a8659e51\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"d7d3e2168951735b\",\"/knowledge-medium/src/components/util/error.js\":\"6e933cd6f0d9a653\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"4e889a574fcd7b54\",\"/knowledge-medium/src/components/util/suspense.js\":\"dff5ec9c8180bd77\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"46b0e7f7f45f4749\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"f589f48b0c103589\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"4cbe86f26e222901\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"387318963989965f\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"91af583ca48747f1\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"ed054ffb5b128358\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"4c22a698b7740b9a\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"b2c4dcdbaee273c9\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"96dd54676eb44241\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"ce4dd8eb539ad835\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"ed4fc23abfbe0b8c\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"461a8840ea6d4721\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"ebf280e5261ee67d\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"9e50324ca1e9186e\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"d4742bbf6a9cd9b8\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"33fdda2e354ffa36\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"f12431435b64eb3f\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"45815344c83faa20\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"d54e53f0681f69ec\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"f17e3aa60c488d3a\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"f967e4ede087a200\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"cbfd6f188cebda12\",\"/knowledge-medium/src/context/block.js\":\"2e8ea0701e2616e5\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"3b41924b26bb0099\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"7504cf7523647149\",\"/knowledge-medium/src/context/repo.js\":\"9fc0a241bb7b8e04\",\"/knowledge-medium/src/data/aliasClaim.js\":\"fba283f1f6754bed\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"00e4086dad81cd91\",\"/knowledge-medium/src/data/api/blockData.js\":\"a7e7f055e79494f1\",\"/knowledge-medium/src/data/api/blockType.js\":\"cedcc5bb86a6ab09\",\"/knowledge-medium/src/data/api/changeScope.js\":\"adce9248c15f6dde\",\"/knowledge-medium/src/data/api/codecs.js\":\"f5aab64a055fc057\",\"/knowledge-medium/src/data/api/derivedData.js\":\"e396ba0f08485f28\",\"/knowledge-medium/src/data/api/errors.js\":\"d574b4b52a9e7f95\",\"/knowledge-medium/src/data/api/events.js\":\"f39300362db2fe4f\",\"/knowledge-medium/src/data/api/handle.js\":\"78f31d2c504cd6ae\",\"/knowledge-medium/src/data/api/index.js\":\"3077667dbf628638\",\"/knowledge-medium/src/data/api/mutator.js\":\"09650146df1b60c3\",\"/knowledge-medium/src/data/api/processor.js\":\"7e1da4212aac7092\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"23d75a2b06b6bf67\",\"/knowledge-medium/src/data/api/query.js\":\"54f46ef03a99a43e\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"3215f33540a10986\",\"/knowledge-medium/src/data/api/schema.js\":\"78f31d2c504cd6ae\",\"/knowledge-medium/src/data/api/tx.js\":\"78f31d2c504cd6ae\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"31c7931ac2bc8e70\",\"/knowledge-medium/src/data/api/user.js\":\"266e5b40f593c409\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"a9f553db668aba70\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"b7c42ba42e5e30a1\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"8e224dc2321fd50c\",\"/knowledge-medium/src/data/block.js\":\"510da214bb4b1d79\",\"/knowledge-medium/src/data/blockCache.js\":\"c0c12c69d48c8354\",\"/knowledge-medium/src/data/blockId.js\":\"62be707fa5711314\",\"/knowledge-medium/src/data/blockLiveness.js\":\"33b28db02f52ae39\",\"/knowledge-medium/src/data/blockMerge.js\":\"6bbc6e27d986baec\",\"/knowledge-medium/src/data/blockSchema.js\":\"57180fb36c496d11\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"5c7fb0654cfba177\",\"/knowledge-medium/src/data/blockTypes.js\":\"b13142662aa2cb98\",\"/knowledge-medium/src/data/childrenView.js\":\"4ba7f6c0e10d11dd\",\"/knowledge-medium/src/data/clientContext.js\":\"81a73872869ce6d8\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"ca7dea8f75b1bafd\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"4b10d6805803c412\",\"/knowledge-medium/src/data/derivedIds.js\":\"d69727c758534dbd\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"0ed5f52f58a52c0d\",\"/knowledge-medium/src/data/facetBridge.js\":\"f6204117621415d0\",\"/knowledge-medium/src/data/facets.js\":\"df9e88d72359f0f5\",\"/knowledge-medium/src/data/globalState.js\":\"147a7c3b5a808132\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"5e6c71043a2a552d\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"c73192af34c37433\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"cf4ac462f9641b56\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"775fb63a76b0125e\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"62c833f1121321ee\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"908357db108a8cd4\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"a7c48c5f02811cb2\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"fcfaed35d6737902\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"99daab8f2333aa09\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"1ae241256a0e3b92\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"eee6f4605a509462\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"0156b48c01353b27\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"2841b3ce0ac65384\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"a283c13174edade6\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"6cd1c31b4ae44ae2\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"7076d4eb5d34f965\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"a976e969afbfa5f9\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"9d3061d33cab7bbd\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"b8d49dcc0e60eb99\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"ad860fd12f3dfb8e\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"16d59545a955c5b4\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"6b683c6664a83854\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"42929a9c8256edd7\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"14f28d7096cb9805\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"c7d247703ebe0aa0\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"808271530be8c56a\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"54a8aff5edd8f764\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"871c3d999d0bf566\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"6754208930410710\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"2fb073e9be215487\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"1ccbeca30b6687f0\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"0697ccc440ba201f\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"9edcd96fc6192a6c\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"7bdda55ff52b12fa\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"3bd3057ec92b8c7a\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"b2de5399beb274be\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"47dd90940988ea77\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"a3a72a850253d87a\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"ed6bade29e0cb534\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"ef3b983339f308d5\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"f31b09ec3d604b0b\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"91e79b8ad10ea5e7\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"c480987cd0981a59\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"2676ae07628aa6bc\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"20c7033fa7f8a464\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"d07f337c9d842171\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"51c999be13d28d81\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"9225d290318ab08b\",\"/knowledge-medium/src/data/invalidation.js\":\"14f46156c6683b00\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"8ff3387a36fb91e8\",\"/knowledge-medium/src/data/kernelPage.js\":\"b87d34db52531903\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"5d3bedd7233f0334\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"5619d989670a2636\",\"/knowledge-medium/src/data/localDbStorage.js\":\"c09dfc2b52eb8de5\",\"/knowledge-medium/src/data/localDbVfs.js\":\"e6aa0d4426eae379\",\"/knowledge-medium/src/data/localSchema.js\":\"d4766170af1d3bd0\",\"/knowledge-medium/src/data/maintenance.js\":\"c2f741652eeb4462\",\"/knowledge-medium/src/data/mergeProperties.js\":\"9443df0f2faba7e9\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"902942b742a55609\",\"/knowledge-medium/src/data/migrationsPage.js\":\"6e2272db502213b8\",\"/knowledge-medium/src/data/mutators.js\":\"d6783baf8576c4ab\",\"/knowledge-medium/src/data/orderKey.js\":\"deac4d00eea3c830\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"07405320032ba5f8\",\"/knowledge-medium/src/data/outlineSurface.js\":\"70bcc4af1cbf3061\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"151ceb64f2843361\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"c27c99ea374449d5\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"190006901118b0db\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"f365b816df12c9b5\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"d5c907caffbbbe85\",\"/knowledge-medium/src/data/properties.js\":\"d03528f4ba4aecda\",\"/knowledge-medium/src/data/propertiesPage.js\":\"bea19ec13896265a\",\"/knowledge-medium/src/data/propertyChildren.js\":\"91ff607d10e91fcc\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"28288ecd6766af99\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"014b9e3d0c98cd1d\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"19f8f13dd3b1279d\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"ecf9e751e1d93893\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"2516c727274b654a\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"7b3eda80bfb1cdf1\",\"/knowledge-medium/src/data/propertySeeds.js\":\"ff769bdeb113e4ab\",\"/knowledge-medium/src/data/recentsPage.js\":\"3000037eff7074e6\",\"/knowledge-medium/src/data/refTargetComparableProperty.js\":\"da9cade6095dbda1\",\"/knowledge-medium/src/data/referenceBlock.js\":\"6e8b28b3d129bedb\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"96e1c9331ace0f34\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"b68d96fe3f95c394\",\"/knowledge-medium/src/data/repo.js\":\"494259a10285d8b8\",\"/knowledge-medium/src/data/repoProvider.js\":\"2c6124d23b5e92f7\",\"/knowledge-medium/src/data/rowProperty.js\":\"bc80b3c11e2be999\",\"/knowledge-medium/src/data/searchFilter.js\":\"db1eb6d8f6ca44fb\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"f65fb80aa5588f3e\",\"/knowledge-medium/src/data/stateBlocks.js\":\"a95475af700e515d\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"4d7af202cd57f4ca\",\"/knowledge-medium/src/data/structuralInsert.js\":\"b9b48578aea61738\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"03dc165f9d7b8d38\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"27d28ec53db8fca2\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"e7a56dcc45a24e96\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"f9d9458bf1caea02\",\"/knowledge-medium/src/data/targets.js\":\"fb09be0ae9094cb9\",\"/knowledge-medium/src/data/typeColors.js\":\"91e419764fc1ffc0\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"7f3603e328b2e054\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"155ca43f4ff2fb9f\",\"/knowledge-medium/src/data/typeExtraction.js\":\"c03874bbe85f3011\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"72c85e5e97bcb44f\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"f535db45a30895c8\",\"/knowledge-medium/src/data/typeSeeds.js\":\"105592247fd6c1e8\",\"/knowledge-medium/src/data/typeTagger.js\":\"05da08298ea85fc1\",\"/knowledge-medium/src/data/typedRecords.js\":\"14dce802c9f88a1d\",\"/knowledge-medium/src/data/typesPage.js\":\"b9ac5bf3fdcf90b9\",\"/knowledge-medium/src/data/userPrefs.js\":\"a2af3cfe5fbbe841\",\"/knowledge-medium/src/data/userSchemasService.js\":\"8fc29711167f7fdc\",\"/knowledge-medium/src/data/userTypesService.js\":\"1bfc398bda44ae89\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"bcb79083691afb1d\",\"/knowledge-medium/src/data/visibleChildren.js\":\"58d13b0fc2235bdc\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"b2c2948d5f58f165\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"cb2caad8fbced219\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"24bef8bce5dd197e\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"e0a1fff48a3cbb9f\",\"/knowledge-medium/src/data/workspaces.js\":\"462af56a033e22d9\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"9c68943f3b45bc59\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"f3a535b07dac7f41\",\"/knowledge-medium/src/editor/atTrigger.js\":\"ddb2a8bf97175f31\",\"/knowledge-medium/src/editor/autocomplete.js\":\"f5f453b54adac794\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"5ffb5b3db7e926e2\",\"/knowledge-medium/src/editor/contentFlush.js\":\"42a0de71a514808a\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"b465a77bcea3ba5f\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"99fd20644a0f6d1f\",\"/knowledge-medium/src/editor/insertImage.js\":\"6ac3fdf8a97a9e1a\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"c88aa3d335abac1f\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"022b627233a5f028\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"48316177e93af05e\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"f6d85cbd7c78479b\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"068e48a7c756ef6f\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"2558ae063a296a04\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"6172ec3750a1876e\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"c778ac7017c28b8d\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"0dfa06c6d0ddaddc\",\"/knowledge-medium/src/extensions/appRuntimeController.js\":\"b028ab2ba5454c4b\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"417653a096f58d1f\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"c28aca07acbe124c\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"af4b079547e37889\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"c062cb3afb19e47e\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"f3e3ccfb3b17e7e3\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"3aed7aa0f318cf74\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"df2ce60907f8e22c\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"651f57eea53a41ad\",\"/knowledge-medium/src/extensions/core.js\":\"34d0ede3f6e0ef70\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"b2af4d83a8c15090\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"13d92bfc2a3144fd\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"aab28678430ce0ba\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"095ba7d629faeae7\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"bc8931156ccca5d6\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"9f94f3dd96ec370f\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"1fe3c220e2dbae3e\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"726670e96fad7897\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"e424ba7dc14f0088\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"cb3613f1e846af2a\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"35de017c3489185c\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"527b6900c9c42c70\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"d91c05df5c5db1d6\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"a64c32bda8f5d26e\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"8bf452159069d5e2\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"5591e81369261f32\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"6684c36c1d91a47d\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"fa47066858a81434\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"845667bf3245d3d7\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"07236458e6f690f7\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"3280e0b3670fbedf\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"da292ce9afc5a816\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"92d40e20f17f467a\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"47f925244dc5f5ec\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"0525b900207399c0\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"a71292d1cbde19be\",\"/knowledge-medium/src/facets/facet.js\":\"48ead1bce3263387\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"2d3bbdcfeb1451a7\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"be58cb17bcba0256\",\"/knowledge-medium/src/facets/togglable.js\":\"25446f88d6158928\",\"/knowledge-medium/src/facets/variantFacet.js\":\"5b58d9e90151b776\",\"/knowledge-medium/src/facets/verbFacet.js\":\"f555da4b61b3000e\",\"/knowledge-medium/src/hooks/block.js\":\"d6e9fb37d4e61de4\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"ef1193319dd91ae0\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"6a230f21cb789366\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"52705b7de69fac9a\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"460de4ad432d764f\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"b01f05d3ee08ea0a\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"873b92697c585743\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"341a3971584bfdcf\",\"/knowledge-medium/src/hooks/useFacetValue.js\":\"532c8233bbd37d86\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"f17038227b13d4fa\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"98ab4e221b0faad1\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"26f178d417477bdf\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"13f80aa848f72709\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"90db7f14be951a55\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"032893d611126b04\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"74065a60a5c730ff\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"ec7213720c368f99\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"60aeb4b7233e3ea7\",\"/knowledge-medium/src/lib/utils.js\":\"e78eeeef430439fd\",\"/knowledge-medium/src/main.js\":\"c3fc1b5d07ad3cde\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"f839c025296061b1\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"eccc158bde4b38ac\",\"/knowledge-medium/src/markdown/context.js\":\"b53b7eafa594f964\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"9903503e0e838aff\",\"/knowledge-medium/src/markdown/extensions.js\":\"79674a5eb8efe1ae\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"69481af4141bcff4\",\"/knowledge-medium/src/minimal-editor.js\":\"1dd43c33055b253f\",\"/knowledge-medium/src/paste/armedCut.js\":\"3ffa11abe6e5dcd9\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"fa33c9913739ec54\",\"/knowledge-medium/src/paste/clipboard.js\":\"7414a36ae8a16c01\",\"/knowledge-medium/src/paste/decision.js\":\"2f94b55c6c57af9e\",\"/knowledge-medium/src/paste/operations.js\":\"fe4feb4075af7720\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"e974d629bc3e2d53\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"278a9522e576c57c\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"6ee8dbe779f32d50\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"e7c55261c13c2648\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"0776ccf20e789aec\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"072e1476411a4af4\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"6702ec3742217510\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"855bed12b9c7a723\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"4e925a12b8d0a12d\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"6647cb965ab280ea\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"4efb7e4d723727f3\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"d43cc0ca0fcce0b6\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"2bbbfe535c37917f\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"2a660ee0d01129b2\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"49555110589fad1a\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"9c1f2786f7a7b559\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"db79cb6de365e765\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"21ccaf93654fcfee\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"13d41440ee68a742\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"d27235a763f51e2d\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"bf6f8b57e05ec1e6\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"57728f41a238cc9d\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"6ae5769fb0778b62\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"d7eba8f3b6045ee9\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"07928e5590272b65\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"d1ca23ad14570d1d\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"935c859f2b256489\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"a6deb8cf91186615\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"f8f2469308a27af4\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"8d43442fc889dff9\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"b0d0a59938b9e3cc\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"15658dd60165e14a\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"a1e7b41b5e6d3eaa\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"158644cd1e43edb8\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"2672be04d17761d9\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"c943c010d3aff0fc\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"e3ce3c988de9f899\",\"/knowledge-medium/src/plugins/agent-runtime/dayPropertyInputs.js\":\"00c70faa96e0b853\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"3d08105799a6137d\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"2d6475d139efd1e1\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"4e2111adf2755fa7\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"ac6dab0496b15302\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"a73bc6e9dbae41fa\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"91768b06784ba4d0\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"a657c34e7646acf8\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"f16cefcae4ed9065\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"eb2e622efa76ab7e\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"376cc8c431f64365\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"9898ce7796440ca7\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"67abb24bb8db298f\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"8e9c2fd993e32470\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"a292bc74d2d8849a\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"2d22c3dc52410dd9\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"48575306c1298764\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"49158ea6f5453c1a\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"5b6db68acca1b89e\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"9aa12ea1b19d7db9\",\"/knowledge-medium/src/plugins/alias/index.js\":\"46a21929e28c8492\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"488197c39b927463\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"bc0b0638f137e78c\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"af843a601779c7a8\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"f7e9faa2814cf951\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"e38c6b5333bf0d85\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"9b28ad63ceff6e1c\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"84e6c297e0c25bfa\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"17efb1a2c985ad12\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"04dd2711dd93a417\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"eaa4aa0a83176d8e\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"003d3fb4009c8271\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"b59cd4fdb853fb8a\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"1002d88c8881b1b2\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"91cce084964aea45\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"8b0a591f68a9a6df\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"60f919cc5be6d130\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"4d01fdbea89a4024\",\"/knowledge-medium/src/plugins/annotations/marginAnchorLinks.js\":\"3212286bfb309286\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"067ae61762b84745\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"c0af36d38cc337ec\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"d7fac9b2dab0f5c6\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"6102c9b3c4523f4a\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"4f3cf36f23068b9e\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"a7ce4e79d9046eba\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"c330214efb92cafe\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"b2ea4059170082f9\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"3c766fd5cbfe90d2\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"24490ef2cd47ceb5\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"4cf8c953495b437d\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"ddc0b3e69bbb7b72\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"cb3af2182baf99db\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"d67f532ea8e43593\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"94341589c2808773\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"9a66d14186a63a06\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"0d49985ea9856c4f\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"b4ab6ddfdee2a5a7\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"36bdb230e4a49f6c\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"e7758fdb476e39e0\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"5a50e4b1fe0ef160\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"9c36079d5352f717\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"8769f69c6673f29f\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"e3cb02ecbb466f62\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"66c9f3241e90a723\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"74b33db19b0d01e9\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"3e2d6ee3c6d96354\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"8a7e63f4f3c4632e\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"bddef3120feed304\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"c2896ee627e22afe\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"c048b4c5210a79ff\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"2d85eca0a803a84f\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"f628da393e798617\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"f851dfe7a74aabdf\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"dd627026741e5d4d\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"f1d7be6d017f88d4\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"1565805ac4a3654d\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"839792583f151f87\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"2d71e78645ec8f76\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"ce672ec0a07410e0\",\"/knowledge-medium/src/plugins/attachments/browserMedia.js\":\"55763aa4b6ee5eef\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"b67307019889b41c\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"5cc00f9b6da5ff06\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"d4370df985113869\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"e0220d7699998ba7\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"a9566f662c50a919\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"9193107388790dbd\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"90378279a4a97494\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"472b6dfe637a1a02\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"39cfa25fa835cdee\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"dae790a6a1913bc5\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"51b8c27a0ef52332\",\"/knowledge-medium/src/plugins/attachments/mediaLanes.js\":\"1fa9f597679744d4\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"9639cdf62336e4ad\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"387f1e8a840973b7\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"413c9137bb0e7132\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"9f7cb19b98109501\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"3db8fc0b48705d6b\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"19719b6bda6e3fe6\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"d391bf67327be98c\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"cb2af87718514637\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"7d89ce3d5d162ab5\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"2e66f05b0bbd95af\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"cebadfcd6f58e5d1\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"563004fb132d73ef\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"e030f619f8d9e248\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"b413f235b07925e2\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"45d1d09fd8ba0b4d\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"578d312d3982af70\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"fe1379391179689d\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"21ec0979e925d06e\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"dd52aea9cdae00c7\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"8adccfdab9f731cb\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"d859b6feb72fbc89\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"4b369f5d80d39352\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"746e26ce3b130f4f\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"73cc0881a0a373fd\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"14bfe9d2a90f918f\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"92d11a8a9361f9d9\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"ecd30a40b44c0866\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"3abbb308af99af92\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"a13c52c90c60d38b\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"c8d45a354eda7db0\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"b5386fb4d6912718\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"33ed894151625721\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"52bf397aaa9a0e6d\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"8a83c4ef5f66a805\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"5ba75788798d6898\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"043431b69db310b7\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"4ec7115ad7de750e\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"55d36662148575a1\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"ab92fd3aea54fba8\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"eb8c4a27a57c89be\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"082979eae37be409\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"05f8d857c57b8d52\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"ebd295058ff0c7b3\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"b30d87cc50774622\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"bbfad68c996ee91a\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"a625cbf68a2da960\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"c284f92173641f02\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"5f5603b91550b1cd\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"4c965a8b2ed61599\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"cea97ee09910e3bf\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"5b1f35abf6eff78c\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"384244161e0c36be\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"051ab4c8a52588ae\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"df99e21875ee84ab\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"c42eab2030f62494\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"7270ecaa55f27ba9\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"cc6659b4f23e0a23\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"ad8dbdd1bf914ffb\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"b99df62720cba7c8\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"9c3ad8619b291790\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"5a3cf4d224037f4e\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"ff7bcf1fd8bf00d0\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"9fa3595ae7a2be52\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"a2fb3b56eeab4b73\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"e25815b395db2bac\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"6f61f9d7077dca0d\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"2f5b4bdf6a8c57b6\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"83865d4b64aa6d8c\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"7f52a7618c9ef0e5\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"b4c34cb14622d361\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"f98dde3b3e5cc4ee\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"e07870fc017832ba\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"be85ecd76573dbce\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"7e2c7adc8e107fb1\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"cd669be45d30db47\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"343367824c4316f6\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"c0c3a21dea84ebae\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"9642ac50a4611898\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"febafde44c1e11bf\",\"/knowledge-medium/src/plugins/character-counter/subtree.js\":\"80b29db9dcf845c0\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"a99688ce4c7c0ac4\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"81743e2b25179d31\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"fe588a38074e2c67\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"8b29104a822b121c\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"294f6ddf0bdd075a\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"6533d583f4b408cb\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"52bbaa5975810bf5\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"7a98f19c375868d8\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"b4eef22b482c60e1\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"70d7ee9c534f8aa5\",\"/knowledge-medium/src/plugins/contributors/ProfilePicture.js\":\"3243461439c48187\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"2ffa56a3cc4cdc1d\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"cecee80b9e4acc90\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"2c3b1771e5a90610\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"287f68a139d0defc\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"b6f8382b52923f97\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"dc61d62fc14ac478\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"2dd7de6635b95170\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"8a9bea82d1775a89\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"c592806bb42dc44f\",\"/knowledge-medium/src/plugins/contributors/useCommentAuthor.js\":\"9fe84fff1c536ccc\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"69852bf5a8bcaa35\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"afe8a360bcb05286\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"8dcc3b3cf9cd8cd6\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"c855ec59a7660183\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"085500d4158e54de\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"0c0d350e348e6778\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"2bb67a890d4998fa\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"813f6f96da2c728f\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"4efb05c7483794fa\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"c542172ed8f7168a\",\"/knowledge-medium/src/plugins/daily-notes/DayPropertyControl.js\":\"83b5cd6e6a49a90e\",\"/knowledge-medium/src/plugins/daily-notes/DayValueReferenceControl.js\":\"cfea0fee8da51d23\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"0d4c7e3ce3ec6097\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"fb2bd6c1cc08196b\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"f08fb49e3aaab8e2\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"688559e426ee1d2d\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"a598d40255101386\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"d321a140aa02aabc\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"899210fe8af567bc\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"1edda295e142c499\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"942b7a832093a81d\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"34ec88cd5bfc383a\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"7668459a4155a987\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"854a6b187417dedd\",\"/knowledge-medium/src/plugins/daily-notes/dayProperty.js\":\"aaff15fa0f3c7cc4\",\"/knowledge-medium/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"8860a2797edac7f7\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"5157573ae686594e\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"bfa97df99a2abcc1\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"3064daa261ee772a\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"7c20bae40eee55d6\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"7f985b9461277668\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"055e030b03468575\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"83558468145a55db\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"1a6081c53d2847b2\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"c1d993f698423423\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"158f7106727c2867\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"5ac5468e7041a19b\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"bd3c0e0652d50750\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"dbac3cb5a83073ab\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"a26a086de442a73b\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"565034ccd9491ed2\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"0be53d26ed378338\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"a69db4cce3bdc861\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"7c94aace3bc6b6a3\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"b6d4774ab32a3b33\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"c9cc7545dab3ccd0\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"e40b5bff44e55deb\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"c79f43b1474f4db0\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"4058c176cc6f68a3\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"35c4ee52a688d2b9\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"8b2afcb9b270dd22\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"3c879f372c250e8f\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"93cc6a0a8e9c159a\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"14676b4fdc0a098d\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"8afc1ab30fcbd916\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"5b82654a05506c8c\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"b77774b2ae50fec0\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"983d843a69e0cc72\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"4d8b2c88e7d3ac28\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"5f4e1c28af5300c1\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"e5c13490a84c26ed\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"f8425d828eacc1f9\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"9ab7d2f39e1d5323\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"eb675bf496ee5c2f\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"d2e065464b36e970\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"82a381e846afa702\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"6239830f5d2a048c\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"5f360b6738b8a561\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"a828dc47ed3203ee\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"c918c472166243e3\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"e9c73487d21bcc1c\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"0c47a4f9434c7b69\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"1c764e43c91d402f\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"318c576fc7ac5797\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"524d249bea6fbf23\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"0ff09c1ec4cf2aa9\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"8824dd2aadd0029e\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"e7d0badef78bd6dc\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"beab491105d10b3d\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"78d117b5806f7887\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"4e9e4d16c1b38792\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"91a90059f43893c8\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"874e6129cee362c2\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"28f541c7b689a110\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"98844298a994ad3d\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"8e1cb4247ddf559f\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"51a8e36124515855\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"4ac5c576c3c02860\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"2ab8bcc5b5f19908\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"680fcd81a70aec39\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"9c2aa4002006c09f\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"215b0517ee10e962\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"c2302a369c650e0d\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"fc120b1da4184283\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"c49df9f189554766\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"c3d76a16437e9d96\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"9ed5dcb494531603\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"44150a43c2810ddb\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"f9cf6e41db595993\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"1fdda404beb71f8a\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"c5501e5c6122adce\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"7f95c2c161bc7c0f\",\"/knowledge-medium/src/plugins/geo/index.js\":\"559bfea062863396\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"77054c93948f504e\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"51c1d776f49d9934\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"4b7629f591f4ce7f\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"fff376f731a4e7b3\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"ae31e0a4f89c6456\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"96e928ee33a13e80\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"a76e16562c687ebf\",\"/knowledge-medium/src/plugins/geo/query.js\":\"783e5352f9ab8f3a\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"a9d1c3e204ef0313\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"882fe50c7f2d88fa\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"03d08fca0ac977a7\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"3cc935e0cd0bbe84\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"89a18aeef4aa3cf1\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"73cef47adc8d1579\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"9680f2216eeecf09\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"2792d5a8d9e5c5ed\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"1b0038bc772f06c0\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"1c5c0f2bd861a55a\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"512c7eec397a2b62\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"3dae9f3037228bc3\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"ad5102af314e23cf\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"1a4a218d2c79937e\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"ece7b48b52fd1cd5\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"5d05995949609e18\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"e5b284493e5e56a2\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"f4461d6519b76c73\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"c5698d11ff443785\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"51575bc7a5a9afed\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"572a3b043c1042cc\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"c2572d322996e95d\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"34cf18b39064ff02\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"badf3c972fe4ec50\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"3f2a0114c8604137\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"d401b3c85ee451da\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"92ff88207ae66aeb\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"94273b123bc3fad9\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"970f7e8cc9fe1023\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"3b06eef9ed97bb48\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"f54537643c5d64c6\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"6953ed77894238ae\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"adcd0b1423e972a7\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"0e2581fba7412d46\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"5290719c540b1f90\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"f5f5ba86274a228b\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"a1bcb3b061fd1633\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"94f6f931064c6470\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"2dead6ef5ab444db\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"350cc3f3bcccf699\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"a1b46351ee9a1f73\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"5954516a7699990d\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"8831f18599deb4c7\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"abdaa57a06ac81bb\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"3480d4ab9d0f2a5a\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"e9835f9ba7218d40\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"8a0df624c2509b87\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"1b03e28b39301f9c\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"24b579c24fc11d61\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"4a5ae3f08e7e330e\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"6e3aa61827391ac3\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"911d6a1d827e5763\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"d4b96cc6c8563ed0\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"924f1c8f2f0b2f6f\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"dbd4012e75b5117c\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"d73498e10277c019\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"87677ea93c946a8f\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"da9e470e1b1affff\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"e0367aaa758a3c1a\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"67ac5e2ac1ad6f62\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"650daffd19e009ee\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"e84774fde8d5e132\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"ecedb6a074516ba5\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"12f0400696daccc5\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"af9c28d190d24f1b\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"01aa53fe2b1ff5f2\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"af19c50b402e2a78\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"c9d8b80140214273\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"073e47eb658f7683\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"3f8f27cf7a7f63cd\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"1c8e3f15b4439cd3\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"ce73129a5f6e1993\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"a6882c3579b3dab4\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"85b02ad195e95f74\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"dc75765490258ef0\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"798efa7119457aba\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"f260baae8a115aa4\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"3a77bbc7075e2225\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"7c1dc0e01b0ad807\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"a37b2d888b8062f8\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"f2607150d0d30f93\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"9e165bb39c17aae9\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"571e91d1b1793a3a\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"ae5c1dd47ad43a19\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"b5c627cbe1d33d9d\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"aee198cf9ed8ae39\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"5ed53952ddc2b2fd\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"1d7015d567ff9228\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"91be7cf697abe8aa\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"45a9203d440a573b\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"d9fd927d5afab64c\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"dad3da6d89c6a8d0\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"3f47ed5b7ef522e6\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"0b9883fe56c6e3da\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"66cc73217a89fa00\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"05ca6fb07ee41faa\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"dd6be93a6227e682\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"544cf00080f752e9\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"3ee918dd16551f53\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"aff7408e629412c3\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"5a66343aec5225f4\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"56ca0b4a9a770ed0\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"79ec98aaab324cca\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"d910475b08f0c518\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"24cf9bb39d95d65a\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"c9c9072d0021cdaa\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"7ad1b9962ea0b571\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"ed28137eb48dc2b8\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"b9d5014ac98a56a5\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"37eb1f54efa8f2f7\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"d14d4c135191a953\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"6503353ac37f578c\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"92568d3f8d8d4f49\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"604c316c4d104dcd\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"edf4470dbbbb57d7\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"eab23839c27af880\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"1863a8852f1ea047\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"90250df31a3341a2\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"51def3e2f0276768\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"40606af898d20587\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"2cddbb528a0b7c79\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"6343d11f7889a455\",\"/knowledge-medium/src/plugins/recents/index.js\":\"da6f04489bb72524\",\"/knowledge-medium/src/plugins/recents/target.js\":\"008d4b5987054cd0\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"fd5e30ecda00a3f1\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"dfba57fdbeff6463\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"5777fa2ad75bb85e\",\"/knowledge-medium/src/plugins/references/index.js\":\"508fbc04e76ced5c\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"7e785dc895ee1bec\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"7eea10e6b9926669\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"1287ee7909c921ce\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"fbd9586b9da83322\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"bc6b5524290a3123\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"ce3d245cb377615c\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"6f034d572341a2d7\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"a3441d39283f50b3\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"7418eb36af072c4a\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"55b391eedf42e706\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"c0c7d4a09ece5a77\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"a217e44e4fc113c0\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"a8bbaea798d95959\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"a95a22db5bfde5bf\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"266f937d11af679f\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"d5f20dc09d31f060\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"b323d93858df86cb\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"f313776326147974\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"67efb6f7bf20b9f4\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"88b618ddb0791af1\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"1bee3406b63ef11d\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"5192755e071e8fb4\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"f74493f2d951a6bb\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"dbd5ddb3c4cd65ed\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"23f2f8731cf1c4fe\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"6a789fa1a791cf0f\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"4f30798bb1bd46fd\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"7d237d80db95a307\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"c577207dc3648a8c\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"558046e99f98e6bb\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"4b7ab21c01393a5c\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"9cbf884d0961f4c1\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"e95f5831b0074c1b\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"c49781d9e07dfb20\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"121ccba83d336349\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"1a4bd8545893e3fe\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"fb4e98aa10b92d4d\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"5cdb9fa45b7fe1fe\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"91d9f70bc35220fb\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"5e6e46a8cb490ee8\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"4864bfeda6e9c34c\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"bbdda7bbd681a50e\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"e8bb9a333a05223a\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"c4fa6c27fd6086bd\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"fd97b17174e4a62e\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"172d22570ae38fcc\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"28fc58e33a8e7ebd\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"3e5724cf3642c72d\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"70a66a33c64903cd\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"5289e5ee189d35ed\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"3e0d5f95275ca912\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"cec5c1192d887bc3\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"5c1b715844d98ff3\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"f16ca832219c930c\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"18c2e8f807885bb0\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"594a63a3d9134104\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"3036456eef1c855c\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"a79f8c77e2d5bda9\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"5b665c805cca68cd\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"c3ec87c04fb586f6\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"4b335227f636dc41\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"ffdf8813403be904\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"79c205223d9f8ae4\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"cdd7a4b4b0f0c927\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"63f9b2a0654fba9a\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"6e6cc5c8aebb6d33\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"0205c4ecf353521f\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"c2359515fe902639\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"b9e3f287e59e14ad\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"21c8a319bed67d7c\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"895c72580cf4436f\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"54affce7afbdf93d\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"91e5bf390d903147\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"90dd5bd06f74ad5d\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"e4028a54719e9d3c\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"c2e1daf5f3f9e59f\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"fcc86ac22ffea6d7\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"af48b8be6d6350f6\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"8dfb23ab10420f36\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"19431743a2024a3f\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"a09d0dedf9e7cee5\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"bb3fa336db0b3b8b\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"029323665f1f201d\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"ec6dc8a09c822f20\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"6932e7f6c0078295\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"ded2f5f61a3aaae0\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"0216d96f2a7663ff\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"bb9953858c20b3f8\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"c0c13238fab0bb43\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"8e8a937b498c0c20\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"b99052e6a7777429\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"53044d79fe37af2f\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"06c2ed6409b1d1bc\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"701c1cca5d5d0283\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"9e0ceadc3d04cbcd\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"7425d411bc3ba6b9\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"a81b6732ffa713f5\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"ef7199eea775474d\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"672b49c7843fa19f\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"222e774f5fa015ff\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"abe11f72823a501f\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"2509464b3d0ba7c8\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"a5e11cc1484dced9\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"c73a0ef59500aff3\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"4f1ecfd203ae692d\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"707f1ebf92cecbb9\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"8d8f4c9f33101266\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"4ff96b0241e76697\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"b894ed85ed3e3512\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"358e3ffe866f8987\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"82957f06b324caaf\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"db2d0ad2c96010fe\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"688acdfb15f1231f\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"f584b50329c37333\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"f231ae582d67eacb\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"364439e97e180c5f\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"75cffbd564fafa27\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"bf7057db59f447b8\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"dc121577b0863a73\",\"/knowledge-medium/src/plugins/tables/childrenViews.js\":\"a0aaa7b7f112701d\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"d5abbf8b85c2c512\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"68176b818de45409\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"7799f348a063520a\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"898c5532ab5a0c97\",\"/knowledge-medium/src/plugins/tables/index.js\":\"6116af81663fed2b\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"28ea0d1e22ad0855\",\"/knowledge-medium/src/plugins/tables/model.js\":\"abbf880c294240dd\",\"/knowledge-medium/src/plugins/tables/query/QueryText.js\":\"752249cfa9b1f73d\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"6b0b8f372d430183\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"917db783eeb98026\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"929f157902c74430\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"55d15bba046ba839\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"18488ed2ac0395b7\",\"/knowledge-medium/src/plugins/tables/query/registrations.js\":\"08885e9b5ae3fe14\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"d90cdea566d493f3\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"56c6274018b170ee\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"0779cd3bcdf39c0f\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"1d011e6030d97672\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"ac3c10797b92f5b5\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"c1a38c85857c493e\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"e171ff20074d50ce\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"4c0f64e20a2830e2\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"0042e42356d29865\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"9c58d50f2265dd81\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"cdb54a8f621abee8\",\"/knowledge-medium/src/plugins/todo/index.js\":\"ef3f6c77671457ce\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"3ef581d4196d699d\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"31651d4ca0cea34e\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"79664b6454219e3e\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"3d1553877a9899f6\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"828a7ba5726748aa\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"49537d3a3a3bbb04\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"9767381d7e8c6f1d\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"cc7980ae5811d78d\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"eeaa649ec95833ac\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"3dd9ad02bb10e738\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"300e959b48d3cd6d\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"817ca1676fe5d870\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"abf4617fe6736f9d\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"a27937b5e0fbecf3\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"dc3b61f486b52273\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"1c8d2b2e86802458\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"3ab13d2f68759686\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"47b3bb26720dfb03\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"a0c7fdce52681b8f\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"12373fa23928180c\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"885bab6dffd8f249\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"6e77964f4f454592\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"ee4345c58b6b87dc\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"98db31591334d912\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"530023be3896f283\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"ad0815ce7a6e2e94\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"aab8dfc4e6114fea\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"3d0120e9efeae594\",\"/knowledge-medium/src/registerServiceWorker.js\":\"8c784d5d261e90f1\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"4fa4d7b58067b650\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"e24316b6d0f1dfa9\",\"/knowledge-medium/src/services/authStorage.js\":\"e96217627a893d90\",\"/knowledge-medium/src/services/powersync.js\":\"7fded6d94291b07d\",\"/knowledge-medium/src/services/supabase.js\":\"741ec07d9eed433e\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"0b2971f7323d07f5\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"4e433cb297d23ab0\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"8693576627563359\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"06919398d890b083\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"4b7013e9536e0396\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"cfb4238da62235bb\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"79510cfde98781a8\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"23b53ad59c13fa95\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"fade24d14cf3d5a0\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"48cdd61044472ce8\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"b5c93123d8acf34d\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"bdd040955f68c77b\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"b4c4d16158b405b1\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"758bb701ff1e77bd\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"473d91c766a76bc5\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"56115a3c73fadc2c\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"50a8378d17f5a4a3\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"071f594758a2d2a2\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"89cf61302839b2c6\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"099a3f481e6a2a22\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"94b88b25a4e4da98\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"0c4b1a5780f13139\",\"/knowledge-medium/src/shortcuts/types.js\":\"1d0c314d0c802488\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"ee0027d67f577c76\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"b91c19d22ec8de20\",\"/knowledge-medium/src/shortcuts/utils.js\":\"7cfc3a9aacc97ae7\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"1875d61bdecd5cd1\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"b35cee007058ec63\",\"/knowledge-medium/src/sync/byteTransform.js\":\"e4922332d175d6e7\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"88f52e826359fdf8\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"46e198d5bdd9347f\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"e2f00ff71c383ced\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"cf50f59b9c1222e8\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"670770510dbba0e5\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"f4e71499110aee54\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"01d9c87160c4ad7c\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"421e7576f72f412d\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"8ad67dc8c90bb0a6\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"f7c178883a01d6ac\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"2804ecccf42693b8\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"598d201c9e0ac8d1\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"2c03ba655dfe0bbb\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"bb4063ea080bf909\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"6427afc755db0349\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"f862c2a209140156\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"04464d888c7927b6\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"ef4f2259e9a00c26\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"aee0d942a1c53b50\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"5601eb13d8234d8f\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"52ed0b0138a1884c\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"546d16d428ff0304\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"15591fa534ea58ed\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"ab96baa59a04369d\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"a3fdaf314de9cdd6\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"f207624b05031210\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"9582849b5f6f9fd2\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"f3537293a8f7da9c\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"3901e5fa635068cd\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"b9eef71f1a6e3da1\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"7592704703300e58\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"4f99a6a14b10840f\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"ca6f2ab0ff830e11\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"2546df7e564399e8\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"45f29e43803529f8\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"f3db3e3fe7e7e673\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"ab313268bfa30444\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"a2d9a08546f777df\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"8b9f2d4fb84d3efd\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"4457d2f7f8c2b7ef\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"a9aa1407d37250d0\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"bbc31be4b52bd2c3\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"71ec9eabf23ae793\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"c4b07046cfa76581\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"e921f8c4fc76858f\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"c379bce2f134aa32\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"bd754ac8406840fa\",\"/knowledge-medium/src/sync/transform.js\":\"cc7500099b6b1711\",\"/knowledge-medium/src/themeBootDefaults.js\":\"b50d281897a9f784\",\"/knowledge-medium/src/types.js\":\"bc6edc384d24f5c7\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"fe71607744da2d24\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"cc231d4a87a2f432\",\"/knowledge-medium/src/utils/array.js\":\"8d6d21af3badd303\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"f7e3a843ba3d54f3\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"a3a5a70549b7c039\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"3231937eaf56229c\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"125a95077a261be9\",\"/knowledge-medium/src/utils/callbackSet.js\":\"3c39be380cf604fc\",\"/knowledge-medium/src/utils/clientId.js\":\"394ecac1b8bf7313\",\"/knowledge-medium/src/utils/codemirror.js\":\"864f682af82fae0e\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"262b11f416b50142\",\"/knowledge-medium/src/utils/copy.js\":\"c73f49459d8fd017\",\"/knowledge-medium/src/utils/dailyPage.js\":\"aaa458d1f21fdec8\",\"/knowledge-medium/src/utils/dbForensics.js\":\"7d7c60b312f2700c\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"a10df0d6dbdd3ae7\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"5ebf19944d3bc77d\",\"/knowledge-medium/src/utils/dialogs.js\":\"5b49e2fb6df781a7\",\"/knowledge-medium/src/utils/dom.js\":\"2e39cf53a177f825\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"79cedaa615315a01\",\"/knowledge-medium/src/utils/drawnWalk.js\":\"3cc47c317998fb98\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"cb73ddbad4e8437f\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"d32235405e15f341\",\"/knowledge-medium/src/utils/flipSlide.js\":\"cafad3709ed5b9bc\",\"/knowledge-medium/src/utils/fnv1a.js\":\"bed583972f89a6e7\",\"/knowledge-medium/src/utils/formatBytes.js\":\"3bf6b0455ad0aa5e\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"9b20a7853f881a0a\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"1a5a04ed36e07f49\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"952d23010b6df41c\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"5985924bb6522c98\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"4c6133bfc5692eca\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"660d09e2f7ad842d\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"15a076e2022ca1fc\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"1b0020fa13ffbb02\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"25d5cad1fa3efb22\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"741588631562aaab\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"2b14fd85b2c71788\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"8a8f0856c2a8c025\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"1807e109b97d9e92\",\"/knowledge-medium/src/utils/markdownParser.js\":\"81b5c912ba8da59f\",\"/knowledge-medium/src/utils/memoize.js\":\"4957b756ba5b13e9\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"987ccfb69aa9cb1d\",\"/knowledge-medium/src/utils/nameList.js\":\"b0992b439361df93\",\"/knowledge-medium/src/utils/navigation.js\":\"fba8800b39185272\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"60c56e925d2b42e8\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"68df0ab5bf1c7d17\",\"/knowledge-medium/src/utils/panelClearance.js\":\"9bafa35e6d9a4d9d\",\"/knowledge-medium/src/utils/panelHistory.js\":\"69aea9747af8da0a\",\"/knowledge-medium/src/utils/panelLanes.js\":\"b5a6790106d4f576\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"9758e08aed29a5ae\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"de0727f6e5e6080e\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"ebc654542e0122b3\",\"/knowledge-medium/src/utils/platform.js\":\"7e551e5035c1b318\",\"/knowledge-medium/src/utils/pluralize.js\":\"e944a8d597c34f63\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"3db53e28462a5316\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"5db516d2e3199ccc\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"7b6e287e48c1459b\",\"/knowledge-medium/src/utils/react.js\":\"a9c2e6dc828f14bc\",\"/knowledge-medium/src/utils/relativeDate.js\":\"ead69afbb16d3ea9\",\"/knowledge-medium/src/utils/relativeTime.js\":\"c0ed74851893e91a\",\"/knowledge-medium/src/utils/renderScope.js\":\"d6369edb6f514c6c\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"82419bcc70cee80e\",\"/knowledge-medium/src/utils/routing.js\":\"4a24663dd9269076\",\"/knowledge-medium/src/utils/safeMode.js\":\"627561656fffc9ab\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"ff30b4973e09543e\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"6c2ac9deb12eaf43\",\"/knowledge-medium/src/utils/selection.js\":\"544bf25b6d923a16\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"c8453b267b6e9a05\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"32ca0e06c7865dd5\",\"/knowledge-medium/src/utils/state.js\":\"ccffea7ecb372ee1\",\"/knowledge-medium/src/utils/string.js\":\"ca68b130eedc242e\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"eaacbf0885b47fd5\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"758be11181e9158c\",\"/knowledge-medium/src/utils/toast.js\":\"ef3bd36d357facae\",\"/knowledge-medium/src/utils/toggleStore.js\":\"fd4fa19729cc7521\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"ad64726f016d0136\",\"/knowledge-medium/src/utils/userActivity.js\":\"ce141c3e8605ce3b\",\"/knowledge-medium/src/utils/viewTransition.js\":\"bfc1cc7949d8a750\",\"/knowledge-medium/src/utils/viewport.js\":\"0ccb1420adf921df\",\"/knowledge-medium/src/utils/webLock.js\":\"3b316570fead722c\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"2d42a6f15f8db931\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"b3e902d4f6f56f7e\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"248f648e8be95a72\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"b6b2d1cbfe861771\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"622e30ee5a4b9402\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"0f45b81299f9c606\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"6dfc150edd1f6c07\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"eaaf66a2824d8ebd\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"9c92ebc07a823cdd\",\"/knowledge-medium/src/vendor/react-dom.js\":\"d7d1e70c5f4ef1a3\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"110288267bb67756\",\"/knowledge-medium/src/vendor/react.js\":\"8a4c054eec588ad5\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
