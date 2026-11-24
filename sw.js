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
		buildId: "76669e37cd1e-8ef9f3e2",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"8bed35b0a8f60e34\",\"/knowledge-medium/index.html\":\"8bed35b0a8f60e34\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"dcb68bea1e734b49\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-DbGqQMi1.js\":\"51b8b0264f3e5b74\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"b6465b54372bdcde\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-DKoz8eNy.js\":\"23c8f383676bd9a7\",\"/knowledge-medium/chunks/FacadeVFS-qTAw3Y7l.js\":\"0dd54375c42afbaa\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-BZoaujrn.js\":\"56adb8bf94a6b3ce\",\"/knowledge-medium/chunks/MemoryVFS-DH70DwvA.js\":\"4828f358c420a482\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-YVHsVpgw.js\":\"5fed2c9bbd16ff21\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-DuRxfh3V.js\":\"3dfd4693e5392933\",\"/knowledge-medium/chunks/Preview-CaLuhSSH.js\":\"c195530eb157c2d7\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-xKIBCMIo.js\":\"b8010df9db9d190b\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-CBGQeWoa.js\":\"84e3aa19eb118e02\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-78HbVTbv.js\":\"8a5ef49053c2b0d4\",\"/knowledge-medium/chunks/react-AXbyeeG-.js\":\"0609741252a738bf\",\"/knowledge-medium/chunks/react-CJ5mN9Nr.js\":\"48de10479ee87b68\",\"/knowledge-medium/chunks/react-DABdBqp2.js\":\"61b88d95824f8d3a\",\"/knowledge-medium/chunks/react-DAOCbIU6.js\":\"eadbc1a9781bc86d\",\"/knowledge-medium/chunks/react-DTyLErDn.js\":\"f3caca8b39fa2b21\",\"/knowledge-medium/chunks/react-DXfyOTTA.js\":\"ea3fdb93fcf09d42\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-CksnJecW.js\":\"05a4348c4f641022\",\"/knowledge-medium/chunks/react-dom-server.browser.production-DAg-Oqwu.js\":\"0fb65d33d8e56fcf\",\"/knowledge-medium/chunks/react-dom-server.edge.production-Dq8Sp-A5.js\":\"07527f68709733fa\",\"/knowledge-medium/chunks/react-ub_r3_jG.js\":\"a1357c1f875bd7cd\",\"/knowledge-medium/chunks/server.browser-CypUKwFx.js\":\"6167eb21c67bc54c\",\"/knowledge-medium/chunks/textarea-BjJjm5ty.js\":\"03dd8ab92260071d\",\"/knowledge-medium/chunks/ui-CZpo2fHu.js\":\"91d035a7fbe56790\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"888df5881ba9f759\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"a5fea9581a2a632d\",\"/knowledge-medium/src/appUpdate.js\":\"edee0c2df0d9904b\",\"/knowledge-medium/src/appVersion.js\":\"408d3653032f9457\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"ec266459e73d1c8d\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"f01de128110319c2\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"13bc0ce169dd02bd\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"d85b46925344a53b\",\"/knowledge-medium/src/components/BlockComponent.js\":\"a05bf375d37fdd96\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"7eebbb6db1ace863\",\"/knowledge-medium/src/components/BlockEditor.js\":\"51c1ce7c694fc3a1\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"ce7fe7d1450365c0\",\"/knowledge-medium/src/components/BlockProperties.js\":\"3d94151077510a25\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"a608717df31da8f1\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"204373fb7d381e66\",\"/knowledge-medium/src/components/DividerHandle.js\":\"97a061eac94a8490\",\"/knowledge-medium/src/components/DraftEditor.js\":\"86939df47afb9ae2\",\"/knowledge-medium/src/components/GutterPill.js\":\"a0cea7e6dfb81a5c\",\"/knowledge-medium/src/components/Header.js\":\"1cd7c0b3368e6968\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"eb9cc7e0123eb894\",\"/knowledge-medium/src/components/Login.js\":\"fb806be6fe3bc3bc\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"7fb9e9adaa7a9d28\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"9d6861a6d145354d\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"b16d7cc90c7a9a57\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"f0ac0696a1fb9956\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"1819f6396ae14291\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"2d5e48a553e22b55\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"6d142b1b022ecf5f\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"c57f34f15a2b76ce\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"66370bc6dbdf9a1f\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"7645c017ab2c7de8\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"7c8390ce301c1349\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"9f913c4e70e9580a\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"684c2dd637a752f6\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"e5644bf3b0596d69\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"39f3f04763914fc8\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"b20412a48a2f7e1e\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"55227d7f4738704c\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"dacbd6487c3d920f\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"d4e06cde0367f8c5\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"c14f787ddefdfaa1\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"cfe877defd468dbc\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"fdec670083ac914f\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"5081d90fe6a25eb4\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"d374a7fb40261e6d\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"43f1fb899654db02\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"db0473aebbb40802\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"3c953a295f132758\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"6d96913273dd7076\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"967c5403b47345fe\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"2e9ccf8eb917a6cb\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"19f21ba97d40bf23\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"692f6fcdba85a4ae\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"ab23c79c47c73475\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"1393029ad0463030\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"55b6b1bc620c0764\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"35f9606b8331ee75\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"15f4fed65ef1941e\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"737826d5760561ac\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"6c11b427e1311e42\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"b4c39bf3ff63faa5\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"306a50352071c17b\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"08461054f6cb0843\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"3ffe1c3f65346816\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"8950013f9e6dfc17\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"91e8a72be5af036d\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"2c4165b76d889a5f\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"bf6618fd6efb5847\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"c7e77d365c7f8c4d\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"233056c1f4359c96\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"32bc01b2fd70e25f\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"9d31b31f2870a200\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"152dcedbd6af82a0\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"081e6a657f19ad19\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"3ba378d2037d3afe\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"81dbd817da367a54\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"5cc824a1af78ff2c\",\"/knowledge-medium/src/components/ui/button.js\":\"4cdcd82979c658c7\",\"/knowledge-medium/src/components/ui/card.js\":\"374906fa8ca2a6c1\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"72fad0b0f12c0a17\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"4a68494782351c2d\",\"/knowledge-medium/src/components/ui/command.js\":\"c72533065082fef9\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"d09c95a6e8e0025a\",\"/knowledge-medium/src/components/ui/dialog.js\":\"1172bb7174f90cfc\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"7c51f79d718e45ed\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"627d8a7b2a999074\",\"/knowledge-medium/src/components/ui/index.js\":\"9a28b00c33ce3be6\",\"/knowledge-medium/src/components/ui/input.js\":\"bc8487c5a5c8f952\",\"/knowledge-medium/src/components/ui/kbd.js\":\"4d28dc189646b7ef\",\"/knowledge-medium/src/components/ui/label.js\":\"69e72b997c67e4e8\",\"/knowledge-medium/src/components/ui/textarea.js\":\"6d108af2fca20797\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"9b0e12fd7bc8f5cf\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"30456a329ab0e164\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"52afe838ae216952\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"0cd5c7361b7dcee6\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"4e8c0abf9c89aec1\",\"/knowledge-medium/src/components/util/error.js\":\"bc66e01b4419253f\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"87cb41f27ac569e0\",\"/knowledge-medium/src/components/util/suspense.js\":\"50dfd9f50730d3f1\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"60323db6687e5b13\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"ddfd52b708125996\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"24fdd37f5258dff2\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"5d1ebb25425b0008\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"2724219383c09c76\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"543d88e42e752994\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"6a80ec2a35e7f552\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"1c36b55d423c05b2\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"0848bd3ea7f3cf9f\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"fb683c247aaf647a\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"cd90ea557a270827\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"8f611a5c1e2db66d\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"44dafe92679ad8b3\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"e5001a8c3b27ee0c\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"337a531ef47c168d\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"75dfcab1e615d508\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"a95bb97fa8f1e83a\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"f78bf5ddd5e54030\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"6c255bcc2f47794f\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"9fc29d9a35f17569\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"a67961159e1c8341\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"f631a477b85fd0c9\",\"/knowledge-medium/src/context/block.js\":\"4c328b9f130985ec\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"a0fb00fe1a90a65a\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"eb9a7b400c269712\",\"/knowledge-medium/src/context/repo.js\":\"83b59c941b6a34a2\",\"/knowledge-medium/src/data/aliasClaim.js\":\"3e66e14a47708d26\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"2415d57e9fe12e35\",\"/knowledge-medium/src/data/api/blockData.js\":\"89c027c1aa9bc29a\",\"/knowledge-medium/src/data/api/blockType.js\":\"b1bd2333640138ba\",\"/knowledge-medium/src/data/api/changeScope.js\":\"f8b6f30891fb5080\",\"/knowledge-medium/src/data/api/codecs.js\":\"7dcdfe3e135fbafe\",\"/knowledge-medium/src/data/api/derivedData.js\":\"6b84aab411bf56e9\",\"/knowledge-medium/src/data/api/errors.js\":\"1738859ccac2006e\",\"/knowledge-medium/src/data/api/events.js\":\"1a1ff34d922c49dc\",\"/knowledge-medium/src/data/api/handle.js\":\"1cc7343951373d79\",\"/knowledge-medium/src/data/api/index.js\":\"2afa2af7ae5b3f02\",\"/knowledge-medium/src/data/api/mutator.js\":\"b2ca1e7359ff2047\",\"/knowledge-medium/src/data/api/processor.js\":\"d0e6f3ea5c0b8d71\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"b1facf5617fda634\",\"/knowledge-medium/src/data/api/query.js\":\"0479d9fd86748aff\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"9c24aac85ee0a85e\",\"/knowledge-medium/src/data/api/schema.js\":\"1cc7343951373d79\",\"/knowledge-medium/src/data/api/tx.js\":\"1cc7343951373d79\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"2bbd2cf705b4ee29\",\"/knowledge-medium/src/data/api/user.js\":\"c669a150538c7a72\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"2151ac8e0edc758d\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"7b09fcf4beab6698\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"835129c295e87cd5\",\"/knowledge-medium/src/data/block.js\":\"764f67fc511b5e98\",\"/knowledge-medium/src/data/blockCache.js\":\"507582118667efcc\",\"/knowledge-medium/src/data/blockId.js\":\"1a3428f1a41691f7\",\"/knowledge-medium/src/data/blockLiveness.js\":\"01aeb05772087cb5\",\"/knowledge-medium/src/data/blockMerge.js\":\"0df94e9ea492731a\",\"/knowledge-medium/src/data/blockSchema.js\":\"66000ef49f281155\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"73d80cf672a84e7a\",\"/knowledge-medium/src/data/blockTypes.js\":\"46e59e8690932380\",\"/knowledge-medium/src/data/childrenView.js\":\"c7b5fda2fc452749\",\"/knowledge-medium/src/data/clientContext.js\":\"ceeda6675c6e9137\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"3fa8e2a6fdedf0ce\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"311a851c61d51822\",\"/knowledge-medium/src/data/derivedIds.js\":\"897b317641d03989\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"3a32deaf659647d7\",\"/knowledge-medium/src/data/facetBridge.js\":\"d6db7dfd5c2db785\",\"/knowledge-medium/src/data/facets.js\":\"eca1414539fce106\",\"/knowledge-medium/src/data/globalState.js\":\"c6772b5b9c3e029d\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"59621989305efa2b\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"161e61d2dba6efbe\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"707f7dd2c4cb0afa\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"20dbecc235f1f7c0\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"8ae9cb53a452f0cd\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"20f47c2ee65d1503\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"6db538056defd647\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"91f650250ff64779\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"390c0da7a91ab02d\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"0376983b13e9d4ca\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"969b76f3a14dad02\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"ec1907de49282f8c\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"64256ad8e8b8f921\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"fbe9d10dbaacd667\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"f6e6f19ca1f7e36b\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"c917c0c592a83b47\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"302e6e337eb761d7\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"e218b8c4efeb37c5\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"f5a60ea9f60056c8\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"9e7ae76875bae70f\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"4b539bc563318db9\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"d08911c85f42f27c\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"c076610aa3d97918\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"77d4c65f7cf8b643\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"116d0754765fda1c\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"91332ebc22a18044\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"cdef39cb28c6c928\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"608d5510dd54a7a4\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"249c3342a867abf4\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"4e8b25bc2623b614\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"a0d6cd4b4cc1a0e5\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"b454103555de3326\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"570a5d543afb4d9b\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"6feaff4d70dbd0f2\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"4f6d20a60dd9209f\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"bd421a8fa83c96ef\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"9f187949b20a4d86\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"208869dd37df7f81\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"5fbeb494f2a54013\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"4f59618d306ce573\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"00055e508e45e943\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"80dbbe2b3e1af1f8\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"d08e67f7e98ea55c\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"6dc03752c27672f3\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"c1cc40a186aa49d3\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"8858a348b8381033\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"144146e172c7a0e0\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"86a9489ef86fa4a9\",\"/knowledge-medium/src/data/invalidation.js\":\"7623cc933474bf35\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"c8d51a2c0be45ff5\",\"/knowledge-medium/src/data/kernelPage.js\":\"a47b0485079cfab9\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"ba7fc34fdae1bc22\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"d735f963c033dbae\",\"/knowledge-medium/src/data/localDbStorage.js\":\"5d16dfee3d53607a\",\"/knowledge-medium/src/data/localDbVfs.js\":\"4daa2bbb89c6b02f\",\"/knowledge-medium/src/data/localSchema.js\":\"710b752eb56864ec\",\"/knowledge-medium/src/data/maintenance.js\":\"afc1e2e67727372d\",\"/knowledge-medium/src/data/mergeProperties.js\":\"7c75bc0b3b1f4582\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"4faef58da841ddb1\",\"/knowledge-medium/src/data/migrationsPage.js\":\"6a2de379f9adbcaf\",\"/knowledge-medium/src/data/mutators.js\":\"fb72b07dd73ff076\",\"/knowledge-medium/src/data/orderKey.js\":\"8273b1380c1e87da\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"1716d9052e669465\",\"/knowledge-medium/src/data/outlineSurface.js\":\"aeab18d62ef5a33c\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"4b23b0b3b6c3ca53\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"283f642b05536d36\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"8d22f0407c4fd593\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"ac2f76d51c23caae\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"b9415cf55989d051\",\"/knowledge-medium/src/data/properties.js\":\"30619cf97dc4845b\",\"/knowledge-medium/src/data/propertiesPage.js\":\"b8378c697443d416\",\"/knowledge-medium/src/data/propertyChildren.js\":\"46b21fec63e64f45\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"fbe11766e53f066f\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"e235d3894df20a22\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"4e7bfee48e78e82d\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"388d57a2b7837dc3\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"a07f13ee7db98094\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"94effee9e176c1b9\",\"/knowledge-medium/src/data/propertySeeds.js\":\"2bff42ca021407d9\",\"/knowledge-medium/src/data/recentsPage.js\":\"2d49f414b71a1624\",\"/knowledge-medium/src/data/referenceBlock.js\":\"872ff8d356dc8225\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"eddcafc4c3547e4a\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"dd8bae3ed2ae1921\",\"/knowledge-medium/src/data/repo.js\":\"39dbc495df3ee2ca\",\"/knowledge-medium/src/data/repoProvider.js\":\"a3d63d0acef6dde9\",\"/knowledge-medium/src/data/rowProperty.js\":\"52112cefb2a82a9c\",\"/knowledge-medium/src/data/searchFilter.js\":\"644e518754cb4ba8\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"04c7255b8b381841\",\"/knowledge-medium/src/data/stateBlocks.js\":\"46c7c955fd5bfd3a\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"854f5c2bd4a20748\",\"/knowledge-medium/src/data/structuralInsert.js\":\"b4c2721253328fe5\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"300fb21a05a8014c\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"127034616fa20eff\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"0e2cb5094a3a651d\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"05347fb44863104c\",\"/knowledge-medium/src/data/targets.js\":\"d26c4a1ced2ce3bc\",\"/knowledge-medium/src/data/typeColors.js\":\"7ceef7f9dc973bb6\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"bb7eec41566e3cbc\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"a72d0b1bc711c394\",\"/knowledge-medium/src/data/typeExtraction.js\":\"b168bbc4f8274d79\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"77d1dca2110ed924\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"376dfc0befad7843\",\"/knowledge-medium/src/data/typeSeeds.js\":\"3f3917e6cf08c562\",\"/knowledge-medium/src/data/typeTagger.js\":\"d0c5712a2e8cf056\",\"/knowledge-medium/src/data/typedRecords.js\":\"a7aed1e19e12546f\",\"/knowledge-medium/src/data/typesPage.js\":\"8fa7fd69215269b5\",\"/knowledge-medium/src/data/userPrefs.js\":\"65e81f14c2e742a2\",\"/knowledge-medium/src/data/userSchemasService.js\":\"7edcb7f530225300\",\"/knowledge-medium/src/data/userTypesService.js\":\"744cff7258489b25\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"0a9c285c331d16e3\",\"/knowledge-medium/src/data/visibleChildren.js\":\"7de8f7d980828f67\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"4d772758b35f85c1\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"7f6c271667da6574\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"b3f7a45e1b5d56e8\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"bbd1684fd738ca96\",\"/knowledge-medium/src/data/workspaces.js\":\"3d0dec4fab24e563\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"9ed2c0de11443abb\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"e14b68ec4c1ef17e\",\"/knowledge-medium/src/editor/atTrigger.js\":\"fc068509363c65c7\",\"/knowledge-medium/src/editor/autocomplete.js\":\"4ecaf0b887f4a514\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"fa470cf2d9466961\",\"/knowledge-medium/src/editor/contentFlush.js\":\"fe827e4c67e40971\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"7d4c1c39dc9cf0fa\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"fc59fc7557d9b1a3\",\"/knowledge-medium/src/editor/insertImage.js\":\"1fa83df7f6598aec\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"028b0f7415943bea\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"c44998a0dbf42d7e\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"b395b3bdac8cc37a\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"315c1a8c29ff666f\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"fa97a5abb2ac913b\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"07e27b46d8bfb465\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"6373072c7d500141\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"67f7d3ffe36b8f34\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"0dbfbb314572afed\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"6da8c2981d47ecfe\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"8d46f22eb3756b82\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"04de1b364c16f384\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"6619f84e712c054c\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"f061c48abf1f4972\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"b928e9f2c2cdcd55\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"01d43609b22e468e\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"16de4d106f550218\",\"/knowledge-medium/src/extensions/core.js\":\"49251c6e1d746e6c\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"62f405a1f1db08c2\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"d757bc92cccab90e\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"3cc2254d1f4d672d\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"aefcd08801447f7b\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"aa45f07cc3c725a8\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"14a6b4db4746c464\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"23603c4f107364fe\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"ba42c37a66fbcfa5\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"aa33e349e1993733\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"47ff2b0c5cc55000\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"748df022569a4966\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"f6e0de05210041d8\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"c9609e36d7fd4788\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"c3fcde52c26f4755\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"48ea831a529e7fce\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"4d7e2b89adbefcab\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"70634ed95dbe29db\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"e3874414ec26bf13\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"8a8a6c7d0a058ca9\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"1b9486ad53d8ab50\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"6d34499cfb313586\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"4f5159c37bf6f184\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"fa14617fca0f7cac\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"177c07aafa6c5775\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"1d0c38f24d77d0b7\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"11246aa29a31688b\",\"/knowledge-medium/src/facets/facet.js\":\"9854ea5122d0ae6a\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"a2023dead2a615dd\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"151634aa753f4887\",\"/knowledge-medium/src/facets/togglable.js\":\"354f2c3f51fab680\",\"/knowledge-medium/src/facets/variantFacet.js\":\"bb0ec7e31eea489f\",\"/knowledge-medium/src/facets/verbFacet.js\":\"01e9cb890b935eac\",\"/knowledge-medium/src/hooks/block.js\":\"b4996279c64da5bf\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"1eb6aae9bbdb6ba6\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"0e3980100793b902\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"13e8ee531a5cda44\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"b22f32f2ac4bba04\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"568b0bfd9e6802ad\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"1a0048cbe511b466\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"e38c1c1509e8043c\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"fab164f887f781ff\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"00e57379bc1becaa\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"30ff480191e00526\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"f943d6ab988b5f7c\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"f60cdcbee6d873ad\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"345618f6a8933a1a\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"0ffb3085ee9913a8\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"6c257d759ec4cc31\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"8856f06c29757da9\",\"/knowledge-medium/src/lib/utils.js\":\"bf14211ab653089f\",\"/knowledge-medium/src/main.js\":\"0be0909f369d3eda\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"106e7bbb26ade603\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"01aba366a6d0ef1c\",\"/knowledge-medium/src/markdown/context.js\":\"567cc667cafa2e41\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"0adea1b894b53141\",\"/knowledge-medium/src/markdown/extensions.js\":\"7e3e76a70bc7995f\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"c0ff3ac5030793a2\",\"/knowledge-medium/src/minimal-editor.js\":\"34ec4b2f604588ab\",\"/knowledge-medium/src/paste/armedCut.js\":\"4540d392ae007a27\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"5097cb9c392df9d4\",\"/knowledge-medium/src/paste/clipboard.js\":\"7d67ded4386e833f\",\"/knowledge-medium/src/paste/decision.js\":\"93f16c1248564d0b\",\"/knowledge-medium/src/paste/operations.js\":\"f4288d41ee50c779\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"615d0bd96d6ebccc\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"adc310fc79afe14a\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"26bdb97b5a4f1b31\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"fffd33be58ac7d84\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"a3ca3727d2f7db51\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"e96ed25dad3b24dd\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"228fc9c2fc872e66\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"a2fda62db661d828\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"f86ddd014e18da24\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"0e8216e013725500\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"50d241f703e25698\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"ed1429299a95a320\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"300e0e1b73e11caa\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"6a2adef7fe820a2d\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"dc6c0edf5c25b45b\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"d3d7d632f0847095\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"b9886178115eccaf\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"d2b21725f0636f0d\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"c376474a746f66be\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"5fb2c65996c674e9\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"38828388cebe39d5\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"09ce1bf7430f2f85\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"fa546eb461383516\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"874cb97698f132ab\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"8ed0d0353b954a6f\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"2c4b2d7a507890a4\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"0951bdeeac71861b\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"cac6fc0d89229fb4\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"66aefce939162bad\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"988f9c34ed54f642\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"4a05d6a015847b43\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"1499f5b6dca7e6a5\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"9c141bfd7c48b5fa\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"1364f4a0ffb33642\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"5e85747cec3519e3\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"2ee84f1f8e31ed5d\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"bd90057bafb699cc\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"5b9e1906fd1e9134\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"3130cd7edfd799ee\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"affc35c4fea150bb\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"4f30afbd14d7acbc\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"29b9f826ff421493\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"518df9c3876f4e54\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"94d8309c927276eb\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"6fff3de1369bd06e\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"d761929b4459b770\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"daf9e36d64cb98d0\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"52b9a48fcd4cbd5d\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"02ec73530041ce7c\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"781617816d9f6e8c\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"e73d8e12df1c7fdf\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"2c57baaf897f5333\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"2121dc9a7fb7b4da\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"efa9738c38117126\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"7395059a4984d23e\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"e906674ec21aad3b\",\"/knowledge-medium/src/plugins/alias/index.js\":\"88aeac9ebcae6360\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"6a892e411b6ac6db\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"ee955ea6396c8dde\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"5d2aa8b7c7451895\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"2eda60870202d9ec\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"485532df41884f52\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"35ebbb846ed4fdcd\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"3d2f858341237c58\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"5c9f48fffb07e326\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"5829d8f8a17923a4\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"bdfe3027f4c06bf0\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"a809b21672eeb7c9\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"aa9112fbadab550a\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"8f5689a6a7e40065\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"35b0618ab1afef16\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"5c32b207a0c41138\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"02ff1244518de351\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"adda8f44ecccc819\",\"/knowledge-medium/src/plugins/annotations/marginAnchorLinks.js\":\"2b3b098893506437\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"2d3566306ff1003d\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"fc3401490fcc7898\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"5c71c372fef6812c\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"cce8c5624e033f2a\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"64139ec88e3108b4\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"980cbd0064e37e42\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"0a71e68941b3148b\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"539b9ca9492ec6ad\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"30fc9c773cfae501\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"0066ff9e69927834\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"b051545292497f42\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"fffa0ff7b37f7a9e\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"6b38ddf997a0f86d\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"841bdce87f767b7f\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"47da21c71187006d\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"a781ea094fcf942a\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"1d6a614820e47daa\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"e16cfc3f29b3371f\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"a3b40fd81872499f\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"c1a626eabf21a51a\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"b8d14d4b1567b946\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"ac239fa9073fab37\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"a2c1e4d1bfb961d2\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"f50f6140bccf8a74\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"18022150bcc02c05\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"73d9accd949d46a0\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"62938009c1c66a67\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"b6bb3b84c69180bb\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"5cb5a181310c4117\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"0eb5c86fb9ad9e26\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"2f35a1960a72071d\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"9652e46e57b305a6\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"0e47370186035f47\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"39883c67e5ad0096\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"32a3648338573838\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"965715d42d836d58\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"7e50e53f648319ab\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"5058504438356a41\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"c86334d562277f7c\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"fcd3a3ed0cb6282b\",\"/knowledge-medium/src/plugins/attachments/browserMedia.js\":\"7befacc04fbfcd8c\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"b151d1425ae6d31a\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"7448cd5fc1fd5155\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"2ffedfbba7a57c62\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"4066c28463ace9ef\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"9de31271bf8da957\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"a36bf6a32cfc36ef\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"b9316bdebdfe045e\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"1574faa977898589\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"7b36249760cdf058\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"d44bfdda7b5ec518\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"8e00ec494b99005d\",\"/knowledge-medium/src/plugins/attachments/mediaLanes.js\":\"1f963db3073a3317\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"1f5013c0f0ddc431\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"01f7900067ad0a39\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"3b9dc74fab5534dc\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"d64d9af54e235ecf\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"8c06f7d47dbfc355\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"f5cd2e956a259ff5\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"365695d263f5e327\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"193178c855d28806\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"54b9d6ca66468e3d\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"08ecd29424037527\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"0f8d8cf5696647bd\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"02f516f6aa517099\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"456ed5e14944d2ef\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"35399061e28b8e37\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"bb111c4627c96b19\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"46f69fb18047938b\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"d3953f57bd72d11f\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"5598f12210b644e1\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"6ba467b237b9066e\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"eb9dc630aa65b53b\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"9a029385f8020a71\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"bba29c8909123e51\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"8491d81feeafa77e\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"5c343ad67f38a914\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"262a9268f7eba12c\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"fa4f106814400f4b\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"7e515b3034b9eb99\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"d7c43ce4e9fb7e4b\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"ecc0e2f49de02466\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"38d868f0f74b0eae\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"2c38f9946648ec5c\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"b4cbd12ef73ee9f4\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"9a861aacd469c349\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"887869d2628783cb\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"9928f01c307bd8bb\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"1ab0e213d1536155\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"9b815656fc9e657b\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"eec1ed23785e7d46\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"20efcc112a16f602\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"6d6aee28aa424e7c\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"c81fd257fd64fa3f\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"232929e52121e088\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"bb8fc43ad6b86f9c\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"6c84ada1882e5132\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"165b4ab6392e6637\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"61bd01a0e5d429c7\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"5dcc7e90c2f64d76\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"bbeb67a7321826de\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"0427f82434252ec8\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"164c7669930fa97b\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"f802507e6e7f0f3e\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"d90779a90e8b43ad\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"38365eb42302b77e\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"0fceebde05c29c65\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"344c69c55a8540b2\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"8bba37f48e1f71b0\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"3696c5c6823c3312\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"b17fc39b43cf5b5e\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"b68b5d7bd23ad5cd\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"d3807a0a722a1c1e\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"76c4f05bdac7da7a\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"1ba06b27dd8ff45c\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"69cba09ae7e2007d\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"e03121f5705f5026\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"35442a7b7be6e4f8\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"b8603acd93a09813\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"fa3a6033e0bc4d4c\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"13fdb20fb7152837\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"6507743a849ecd32\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"b3de1de7657c8268\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"6d9a0a461a801e93\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"9f1e440eb6485c6f\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"ca58290da87087cd\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"e205728fd9c56402\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"75167667fb77c1ca\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"4f40df48425b1273\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"5c9f9aabd59ac559\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"bba9fa08578f980e\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"f920b8abf298375c\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"b07fe013eb0b9960\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"4b5770e54eef6792\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"914c556b2fa78b56\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"e948675e72a7f028\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"47f4dcc2d1b05ccc\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"959e31565f1fb641\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"e8e0ced2020d1a50\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"14a2752b6b8b8688\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"e0d23ca13bf9ebac\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"858224a2aa84b9f6\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"a62b96480e4f88f9\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"74cda1a8f0587528\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"bb89c306011608de\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"8b0f696e39160756\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"372a887a24e19a22\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"2bf64d336cf37218\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"1719178e40c46e21\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"5597ea288ddd6c3c\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"a2f4955c6a3b4038\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"cae52fab30d50d7b\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"13d6216518a60cd5\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"f93b4b721f9ac550\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"0f3e910dce970c00\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"e56d72b796e40c34\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"6ad692aa67ec4dd1\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"d159d757f3d44fa9\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"e0d84971064d9de9\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"406cbfbc9fc8c6d2\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"e99c32948e971424\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"bf5343b403517d78\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"02308f59c8491c72\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"0487e11bf8412c7c\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"180c7940fac688ab\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"df7fc3444240ac12\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"0ea363ff416049d5\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"26c211d18d9eea51\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"7ebd7263e74fe6c7\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"8d891c99978e8062\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"5290ccf60adede67\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"ddd633f8862a401b\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"892cd0d14c87cc90\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"822bb600992c0f97\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"ab7c9501a7c717a0\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"956ef69852cec7a0\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"d8ef7c798f37cab8\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"0c8784211e9595dd\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"bec08a6a74cc4770\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"1921a2193216d0bb\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"781b6ac516172634\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"810049cbf4fb4150\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"1e91527b269eef7e\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"79e7f63c71b36e5f\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"8df86ada833b8814\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"f552d458461d132d\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"33cc343be0da2dbe\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"c4514a5cb755bc9c\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"39931c5de003e526\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"e8ab0c22ee50129d\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"e2f5f37609419157\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"7a97c8ee93b22c37\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"be941bbe8b3c8398\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"92a54d9ea4be3d40\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"8263ebdda5d1f46e\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"d4d4feaaaf449f8b\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"8a3a1329f4156aa0\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"a5bbb35428eff158\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"79a848eb796b7719\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"92d6ecaaea84dc65\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"82e7bfbcae08f1d9\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"aa780ca8aaeb26a3\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"c3363535f85779e8\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"72354b2c19fabe27\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"17dc501c501a78e5\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"a0af466f8fa1f371\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"37b1d678d8bdf40e\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"bd56d6c8b66ddc56\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"374d971677372f08\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"db1e3438c3ed68e0\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"bdae2bfe77f44877\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"e3684b3fb073373e\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"d6f407786aa8d9fe\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"0ecadfbb99b9b206\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"4a55366317e59ddf\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"09554a78de4b2e7f\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"adb2acd54fb35aa6\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"3e97619b7a674978\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"4c60507653b018df\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"32ed5e09a2cdf166\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"d8ecb5337d84a54c\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"4fe68045e5d5ccee\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"313fb9654b2aed77\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"3ad6aecb1aa20303\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"bebf97ca125a223f\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"689533f7c1e6a9bd\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"e7fd889cdae476c4\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"5e1ef5cb6481b40c\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"84efa1eb56023e92\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"6f2479137213ab0e\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"609952d75cd472ca\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"4a9b1a4f13481cdb\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"837e85543e66670b\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"2846dc0f6dc7224d\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"187e12b6d78a0a2e\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"7000ea365de6ee77\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"8f2bb4097386214d\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"40b5944c5c6f1d9a\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"11d89aa8bfc5fb66\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"2e36b4e47f6df155\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"2362a68ed9e25ea0\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"05fb56f751c779b3\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"cec21618f5157060\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"e881e514ea025ee9\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"7ca962cfa4335f90\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"11671678a2ffc8fd\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"224abf7a9e327eab\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"7a3b5d254ab62dbb\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"7eb4967731971110\",\"/knowledge-medium/src/plugins/geo/index.js\":\"4c90d933a205f0c4\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"e70f0268c8c18997\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"93dd21cafe7ae054\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"6fa769cc68d3aae5\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"9bb367a3e818fba7\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"40d2654afd49e7a3\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"80235caf23b0b883\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"df030560698baab0\",\"/knowledge-medium/src/plugins/geo/query.js\":\"07a8d551dbb29ef6\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"c41dbe51afc4ccaf\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"4766403b99bb1ae9\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"a26af7057a6ba1c2\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"019fa37f0ad02bde\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"a9d991f00ff8671f\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"b6bc1209e44efb8b\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"fed47a7e5b06487a\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"db062f0be83eddd7\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"170c2fd73588096e\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"ed3c655727b637da\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"1d1c36420fc555f3\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"37ddd269aac54953\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"fa5d539ce23fcaca\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"a6278afb777356fe\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"58decd1f4e632ec9\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"29e4406365042bfa\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"6dbc086c5a4d69a5\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"47fc3662e4017871\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"c101b1f0e89f1c2b\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"4e2d137055ec0296\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"1d5a391c6bb3df0a\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"55fb3a744a9fab6d\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"4d1b6bb1a2d0eb80\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"72dddb31ac1a48be\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"e75e4335e11f981c\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"6bea8edc1e7879b2\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"c61becf5089f9106\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"1e001cbe4b9f0b58\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"0800b400fc02cf6c\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"5813455560f04d87\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"f78ff78e2f26a582\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"f8d08a43e2ee4d39\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"eebf1dcb729f37b7\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"67c69834822c98bc\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"460546fffbf6269c\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"54c124d5997d99d8\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"008994c2ffce197d\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"16cf4378f0d4ea0b\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"f62a26c14177de01\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"2b4bb251c09ad655\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"b045b61cb6f147d1\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"2001c8e94b709da7\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"0388e0c2a5a21677\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"701fa0977e3daa15\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"15a289b0740a7305\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"b1a2ccbd9ab71178\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"0602c25c339febe6\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"3675073d652e8782\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"83f3a186fd81c952\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"4e083289501b7fa6\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"444605d44de965c5\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"5686bc8c45e5cf42\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"67bda1f44d660814\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"fb8c81c35f82e591\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"f44a4438e21bce6f\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"40c32637c3275382\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"70643bfb4fe70525\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"b0f4ef2bf6022466\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"8c984a4df7862914\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"df114e542493e190\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"6e626e9bdb79cadb\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"9eefefe9b6804de6\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"25524fc0836af60e\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"96900bc7ba0c4e30\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"a0ec6d15b9d9724b\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"4fa4d593522fc0d8\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"15ca4808a3380d62\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"a261c7d579eea3f8\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"b54fa4f7b9df7fb9\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"4032ce7bf0fa0b3c\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"9dbc060e5ab8c5e8\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"ce7abb5ca489b30b\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"f74f81bc9e77403e\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"cc626288fac0cfaa\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"183196f0bf997212\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"9bbec88b4bd1b58a\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"de1e5c723f30cb05\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"4e7f8326130a5e02\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"e5d9c3ba7210efed\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"6e0fb04a89f06496\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"f53bd0cbe4f27262\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"75599021c42f5044\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"279cd87c3f49ef81\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"904f35490cd03cdb\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"a9871c235a21a28b\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"ec8ad106d43d78c3\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"818c5ee3606ffbb5\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"65cc587eb3bdefef\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"ee9e83380d34a157\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"87e0d472ab7c8be3\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"1e909d5f6f2a3816\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"a16837733c881197\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"f9795acf946199ed\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"de5fbf3b3cadc751\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"7bc4b963591afb61\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"07f337d84c4750e7\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"260f3c2e5233d162\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"bce2a81c45ddea43\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"691a6803ef84aba1\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"521771df3d37297c\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"db526d107b6353a6\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"3d399d0e844c91e7\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"ba0304a4fed3a8ab\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"b6b30d98c32bdbc1\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"301423fa9601aba2\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"b322cf7582f8edd8\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"f33394e0bc378d8e\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"b878b7c1ed003da3\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"5f5e5ef3a39fd8b8\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"5926f6c7dffc60d1\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"697ce734275a6e27\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"90da14c998cc161c\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"fccdb749a93291b2\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"f211e172ae257034\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"b7415927bd647367\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"66868c9ee3789ec2\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"7de5ab332c513d1f\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"6c5a0240b42adf9f\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"8a477a968f6f0eb2\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"52dde9d615fd1334\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"31b840916e1edccc\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"2496e5008b8975c7\",\"/knowledge-medium/src/plugins/recents/index.js\":\"03ff2aac5b7bb926\",\"/knowledge-medium/src/plugins/recents/target.js\":\"650cf06eef696ca8\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"0add3c81b4b893dc\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"c2074a44d45169a8\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"55289dd780b5935a\",\"/knowledge-medium/src/plugins/references/index.js\":\"97c61bc13e628a56\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"e77c565ca0b96d54\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"00136525b4a5ccc9\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"74eabaa019151777\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"2554bd3b442218d0\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"ebdde0d5a7b01ccb\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"58e21622a8175d27\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"c6ad0548250d9cb4\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"15bb77aea8de59f4\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"4d59ea42c097fcef\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"4027147f5bed0fb0\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"65434821ec0b52ce\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"42b9cd93d637e27e\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"3025fba04aaaea42\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"b047675383a99688\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"a14d6794842b73d4\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"2ad02442b9447b45\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"ed8d0943f2903bef\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"52a8790ea504d215\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"7b22369e9e285fe4\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"8cf0b075018ce124\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"d7b855a6a95a896c\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"444f1f46347773d9\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"b631fd946d13d105\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"47ccca1a051e5953\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"b5e2db0fde80823f\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"ec8f0c0023f7caa4\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"72e5ea4dfaefc83b\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"f44eec0564b93ccc\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"59ba8bcdb6589bfc\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"466812d7315da2f4\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"4ef68c6b74393d51\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"ee31cf90eacc9723\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"40e7acdf430aea9c\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"868c034e7bf63697\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"dc34d62cf0b888c8\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"4c90a8effad7ad40\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"30fa68fc4bb2c48a\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"fe26861a7a7fc663\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"d954c2ba749a2ecc\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"b1fbd45669bdb338\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"69dfd30b10824950\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"cd8534d90bb54181\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"0cce8d165ddcc4bf\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"1d64750b6ef9f97c\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"f281e2f5129d810c\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"8299be538e04c8b1\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"7710117bedeeaec5\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"3b466aed4fb87591\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"8a7bb38ca2809f67\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"c6fc2fb922c62ce7\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"5d5d581dde8b12eb\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"a10ba502ffe66d7d\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"50d08eb861c71705\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"1aa6e04b6b6f151c\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"f907ffd0d14504e0\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"d598616fe88f6e49\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"35814caa306f6b13\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"ba0a3a7705fdfc80\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"94ee75496cd37d96\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"9109f65aa8ba5e24\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"54a68987dafbb338\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"fac008c434cbc161\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"f99d69ccf7fa34bd\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"c5c1b7dcb2cd8e57\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"7e3378ebef472640\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"c142e77527fe8253\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"6acae5f556fe3a50\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"7adf3501e68e799c\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"131c8fc9ac13f1e7\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"f5ff704458d12d3b\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"0886c4124d3727ed\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"88163ca6e3285040\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"2200af127043f1ce\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"d6eba849bd0692cc\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"753715e69135c242\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"258de76ba4528f92\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"4b0e6e90c0a5be56\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"4657485929c48937\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"71897621b8b1a32f\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"bd99fc5d964f1776\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"88e6564c6656ffb1\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"6eb6291ff20e12b7\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"4605626c924f2b9d\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"f4df9d5c10168fb1\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"7801e5ad359a4806\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"3b259cf07fca4d8e\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"fa8e0d35d46c6ae9\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"1695ab3e5a3a37a3\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"e64e86458742eb83\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"d759ac79d7448e14\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"eec81bf51a2615b9\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"ccf1d6f1daf1f6e8\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"7915f79ed274eb37\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"745623fb8bf2f3e7\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"8ec65f65ec0c9d39\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"7add3fae596d43a7\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"805d274f89c52874\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"abfd76ed5e0daee3\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"18d0561920af2c50\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"089bf013454fff7b\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"0f94f756ad9d50ba\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"24f028a4889e946b\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"fe85da7dfc7dcffe\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"fa0e18b48e4d843d\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"69d52163ddef51a7\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"5d2f2d6d43c77b74\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"bb2da22c344e2f78\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"52863fd8362d2fdb\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"1cdcc4a9c1202405\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"6188f6b674cd171c\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"dca73f08bfe930d5\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"c54203701845bed3\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"00f7da4c0737f553\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"68733c4733a421c2\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"6096843c3ddc1df8\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"51ebc269fbe9b532\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"e33872ab8716e497\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"e309329f0ed05b48\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"ac1526246178ee3a\",\"/knowledge-medium/src/plugins/tables/childrenViews.js\":\"923df4e6caff1a66\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"dd74d5988b246c1a\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"c31459277ed75317\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"3deafaef07fafe86\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"4688fabfe9ead9e3\",\"/knowledge-medium/src/plugins/tables/index.js\":\"3215bafad62caf8f\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"b119649f544dff38\",\"/knowledge-medium/src/plugins/tables/model.js\":\"78ace505ca06dba6\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"2cb874dd385f5b38\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"0c6babf480c83309\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"76123f45e22f57e4\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"a9468fdfa5d96681\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"dacec2d63a9609a9\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"25bb97a3e8156f7a\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"0dc90f881f51ef27\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"aae702edca18b7b9\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"f5ac55473c0a9717\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"c90d741944eb8592\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"738045db54f525bd\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"48ede70b241e046d\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"eb4527ac1ae1cf0c\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"6bb3a1af9c961c7c\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"87cbb7e362719154\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"4868f5370e3761d3\",\"/knowledge-medium/src/plugins/todo/index.js\":\"9ed46105c19c7875\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"f55f217098a7a0ed\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"3f09c7ac64261558\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"2af8b9547b31e640\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"09525ee03c1b8b74\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"7cd44da6fe9dd3fd\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"ade914ef92789713\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"6fd348e0768cbb0c\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"79e10fe8ed4352e7\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"56e5083b2b414e5b\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"3946d9ea2701a7d9\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"bc2ccbd3b97ba141\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"757b73e5f35161d2\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"4fed92bbdb49a623\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"eb2f0a4c295e937d\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"42c0f4e933e9b274\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"baa12f2e7c42e6a4\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"d6d1a5b6b9ac912a\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"1bb7f44316dd6f85\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"799bbcbf8ad7da5c\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"dd9efca80b5e6853\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"44a855b228d4e00b\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"fdf27276e4292b2c\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"475be03088315879\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"0e350228acc3923e\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"322fcaac09105f0a\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"4f6e2445d75bae26\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"cd2c1a62adb7b1e0\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"07ce35be0bfd78d0\",\"/knowledge-medium/src/registerServiceWorker.js\":\"6485e4e974130f12\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"ff83ee5c49b633f1\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"d7b99a17cf37f21e\",\"/knowledge-medium/src/services/authStorage.js\":\"8c7c56e08e9b4252\",\"/knowledge-medium/src/services/powersync.js\":\"4535b3fe60667252\",\"/knowledge-medium/src/services/supabase.js\":\"94be29d5d0cfd667\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"24ae1288d372c834\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"57b2153616766cab\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"e81ca26cd8ac93f7\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"bfa66f75444e3fc4\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"efc22e45076c44da\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"035a1d21de4156b6\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"e1294acc9d4391f9\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"33399061450d21a7\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"1f74ae627a286a7e\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"545b2854994b4f55\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"99577677ce64560f\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"fa42f368d230b04e\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"bbfd797bc64a56bd\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"9dbc97bc145fd5ac\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"68829067e8f3a5ab\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"164ac6ff982f7fe0\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"38467573188e047c\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"8546dd8c48a70358\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"f119501a77a32490\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"697808165e3c8720\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"21805cd9408e9012\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"4026fc45334faf05\",\"/knowledge-medium/src/shortcuts/types.js\":\"c17dc4932bccd0d1\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"c4922c1eacf8b930\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"ccbbe38dd6805462\",\"/knowledge-medium/src/shortcuts/utils.js\":\"0422644c6c3503b6\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"860e81616371dc52\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"5e557a05923a60f9\",\"/knowledge-medium/src/sync/byteTransform.js\":\"d4ff0834456ca4e1\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"8d133c1da0bf2cd7\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"aba90acffd03ff9f\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"825420e01067102a\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"63dbdd282cbad540\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"53dea6eb9fb984df\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"e191b570183e537b\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"9a436a6ac203a758\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"2bb9e815e638cd6a\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"4ebd8c3d5d18002c\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"c7f4ac36f083d189\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"9048007a813bce31\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"152996e02dc50db0\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"8ca44d8cefdf784f\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"501f06c29a2eba43\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"eb43792b8f7e3a50\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"e7165581d46501b2\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"31deea9ccbf56741\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"4f1c6f46330b5ece\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"0c949b983a571280\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"e7f92385fddbb927\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"5202c46629516167\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"198384736ba13fd6\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"a69e33784553db98\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"7171969b9b590907\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"6d6852bc59c068d5\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"0976a8332c5f0ba1\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"6cb8607327c5a1db\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"acfbb6e43581d912\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"a42f592aab9ab913\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"99647cd4c79c753c\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"ba7bebb8fd2d102a\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"ff5faa2507c03166\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"3329e2b0d369b414\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"acab9706655e09dd\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"ab399b88dc8fc4ff\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"b64448f8188b78b9\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"63ab35fedb0e7766\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"c4a68fd60ca5cd94\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"85a16997b6403ee1\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"58734d3c69640829\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"a36727d0c43de6eb\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"52c2cd136fd7ab5f\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"e9b296c022d692a7\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"76dbba1a3668aa77\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"34dcc9bda0fb3723\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"1792cbc196e291ec\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"01a003d255fa90e2\",\"/knowledge-medium/src/sync/transform.js\":\"82e0df41e7a64c06\",\"/knowledge-medium/src/themeBootDefaults.js\":\"3ff7bd2f7e5af7af\",\"/knowledge-medium/src/types.js\":\"2b56c0a4d9dcf70b\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"495de2c562c3ed90\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"ba65267de6e619b6\",\"/knowledge-medium/src/utils/array.js\":\"286d4a59411cfdbf\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"55175adbfb521cb0\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"e7f2f7c2ae649e33\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"6e87314338301bd7\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"489f2a6ef06179f0\",\"/knowledge-medium/src/utils/callbackSet.js\":\"06b34fe3e826e5ef\",\"/knowledge-medium/src/utils/clientId.js\":\"2c0d541e9558bab5\",\"/knowledge-medium/src/utils/codemirror.js\":\"95f9aa9cd305f6be\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"003c30ff9996bbc6\",\"/knowledge-medium/src/utils/copy.js\":\"1e3f0bedbe963d43\",\"/knowledge-medium/src/utils/dailyPage.js\":\"ebd8aa817aa0d709\",\"/knowledge-medium/src/utils/dbForensics.js\":\"9be0454fbd3d5eeb\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"9ffa961336379203\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"de7fd0e40ef5de82\",\"/knowledge-medium/src/utils/dialogs.js\":\"b22da3b2e8d841fb\",\"/knowledge-medium/src/utils/dom.js\":\"2982a2a5052c7151\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"639f00d7b425f213\",\"/knowledge-medium/src/utils/drawnWalk.js\":\"88da881bd93ece12\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"f432b82a4cb76f60\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"65312dff399dc0bd\",\"/knowledge-medium/src/utils/flipSlide.js\":\"b778d0f84316cffe\",\"/knowledge-medium/src/utils/fnv1a.js\":\"3da53841772ad95e\",\"/knowledge-medium/src/utils/formatBytes.js\":\"0c595b4627e0d420\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"a5128e309b35aeff\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"0825f5d5a1225ee7\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"69e8510dafe9253e\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"af57bed782e2ea99\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"cc9d1a826fedc2d0\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"e382ce4e605a0257\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"cacf6659a36ca9a6\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"9f6d8d578dc14823\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"91108c22cdb29e77\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"14b15a7e0f43c7d3\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"afc335bbb75d7f2d\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"4090b9e7cea8bcbd\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"e4b980330432b051\",\"/knowledge-medium/src/utils/markdownParser.js\":\"9058ab52b6ec416b\",\"/knowledge-medium/src/utils/memoize.js\":\"78cfcd60371c21fa\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"ed7f753eb8b2f88f\",\"/knowledge-medium/src/utils/nameList.js\":\"cc3e2c0485eecf5b\",\"/knowledge-medium/src/utils/navigation.js\":\"de6b017c5aa2555e\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"4bc6d1651d55242b\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"3d1685bf468fb232\",\"/knowledge-medium/src/utils/panelClearance.js\":\"94e6035a78c50472\",\"/knowledge-medium/src/utils/panelHistory.js\":\"e7bdaf68f92d92a2\",\"/knowledge-medium/src/utils/panelLanes.js\":\"71dcaf0d1cbfb810\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"1710654092a55727\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"d60cedd6065a7a0d\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"a751e3dfc2c928d3\",\"/knowledge-medium/src/utils/platform.js\":\"b676d4eaec35e810\",\"/knowledge-medium/src/utils/pluralize.js\":\"7222fe82b4e324cc\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"5c67cf426215649b\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"4177f42a95a73970\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"7905222e42779440\",\"/knowledge-medium/src/utils/react.js\":\"a11dc3888f2afd33\",\"/knowledge-medium/src/utils/relativeDate.js\":\"a99a1f53c453a0af\",\"/knowledge-medium/src/utils/relativeTime.js\":\"bb195fab5f46cc5c\",\"/knowledge-medium/src/utils/renderScope.js\":\"cc60c73f09e87c41\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"e23d64b43877ba92\",\"/knowledge-medium/src/utils/routing.js\":\"31ad5b6de7a55984\",\"/knowledge-medium/src/utils/safeMode.js\":\"24c4cff67ab4e133\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"b8f57abb5c696a55\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"4b4191a7e3753aa7\",\"/knowledge-medium/src/utils/selection.js\":\"b5ba7357efa490ae\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"908247d25035b4b6\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"fa47d5f4cc6a2829\",\"/knowledge-medium/src/utils/state.js\":\"13510f9f3b56362e\",\"/knowledge-medium/src/utils/string.js\":\"70a60a5c25d8e670\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"18ccf20edce91082\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"11de0786f19d4055\",\"/knowledge-medium/src/utils/toast.js\":\"d9cee5d21528bcbd\",\"/knowledge-medium/src/utils/toggleStore.js\":\"0008f3e47d66f03c\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"d03617b8956f0826\",\"/knowledge-medium/src/utils/userActivity.js\":\"c6507bd3853356b3\",\"/knowledge-medium/src/utils/viewTransition.js\":\"1d1f1d35de297b01\",\"/knowledge-medium/src/utils/viewport.js\":\"6b1fc9eab5e2f053\",\"/knowledge-medium/src/utils/webLock.js\":\"3bd8e7bd7b848726\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"20bb1a69fd5feaed\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"78ca1d8f933b8836\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"4d302e45949b57d1\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"29aa2c1d6aa5c024\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"23717fea2a507ada\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"96df53b5fc44e8fb\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"f76e42ea46e80995\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"0b1947b4f73cfb9d\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"46486128f0070a84\",\"/knowledge-medium/src/vendor/react-dom.js\":\"b932f827505be75f\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"54574ab40f8c84d8\",\"/knowledge-medium/src/vendor/react.js\":\"af4375054a0290f2\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
