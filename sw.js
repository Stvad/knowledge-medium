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
		buildId: "638b42f01544-1567451c",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"4b4630b068cd7061\",\"/knowledge-medium/index.html\":\"4b4630b068cd7061\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-C1hHvaPz.js\":\"b46ff4694e82c858\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"0e01d838046d6db6\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-DMAOm_xb.js\":\"9890c03647ba418a\",\"/knowledge-medium/chunks/FacadeVFS-DuigblbF.js\":\"337bd03813e3e973\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-B0Y8irdz.js\":\"ab05a93c794facd2\",\"/knowledge-medium/chunks/MemoryVFS-B-jRys8x.js\":\"a2f3b5c877641cb4\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-DvwCN315.js\":\"0a899c85fde62ac2\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-DGpK5Fsq.js\":\"5a2cb27a4cbc406e\",\"/knowledge-medium/chunks/Preview-yjDEKQ8v.js\":\"275cd1ecbca25f00\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-D8XLksZ4.js\":\"9d0ef58a139f8b1b\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-fhq8v1aM.js\":\"a26edd5809ce3af2\",\"/knowledge-medium/chunks/freezeExtensionImports-BH8B9xJN.js\":\"e78d43dba6e77d21\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/lib-sLsWaEIT.js\":\"54ea87940a765649\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-7o7Dp3Na.js\":\"9d2a004509844866\",\"/knowledge-medium/chunks/react-B0-eLdT0.js\":\"e99b66fb96bb8993\",\"/knowledge-medium/chunks/react-B8OI1uNo.js\":\"9292b0cdffcf166d\",\"/knowledge-medium/chunks/react-BmD5hoff.js\":\"32958f7818b4faa5\",\"/knowledge-medium/chunks/react-C2g0L8UQ.js\":\"e97c2d186975503f\",\"/knowledge-medium/chunks/react-Caayic0p.js\":\"48ee9f0a46a54b08\",\"/knowledge-medium/chunks/react-D9T7qNNI.js\":\"febea7abc90be5d4\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-Dzg0K_me.js\":\"dd515f577595191e\",\"/knowledge-medium/chunks/react-dom-server.browser.production-Bg3JKZVL.js\":\"f663ca50a5df2c74\",\"/knowledge-medium/chunks/react-dom-server.edge.production-BS7XK8JD.js\":\"3f98e1227a3d5b22\",\"/knowledge-medium/chunks/react-idEVxain.js\":\"9a4b94749166d717\",\"/knowledge-medium/chunks/server.browser-Fz9nJLsh.js\":\"1bea5a9a66395540\",\"/knowledge-medium/chunks/textarea-DpbZ6KTv.js\":\"96d8e6b00568d368\",\"/knowledge-medium/chunks/ui-DnRxtq2N.js\":\"9e0a97aa2dbe5413\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"16b7f7e72c8a8fb7\",\"/knowledge-medium/src/appUpdate.js\":\"112eadc97bf2356e\",\"/knowledge-medium/src/appVersion.js\":\"5bf545593d48bc88\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"4316ffb1aabf6d7a\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"461a62ab681a47ea\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"a167c6a96a8b0564\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"d9f89e696b97441e\",\"/knowledge-medium/src/components/BlockComponent.js\":\"9d6ca00feae1dcd9\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"abc9d76e1181b5d2\",\"/knowledge-medium/src/components/BlockEditor.js\":\"c7c7e42d529d65d4\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"5f6a85cf72b5797e\",\"/knowledge-medium/src/components/BlockProperties.js\":\"1c6b5f4113f32829\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"a575eb30bba5cd26\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"d500c1a1b3cb5b92\",\"/knowledge-medium/src/components/DividerHandle.js\":\"6223aee5b1487273\",\"/knowledge-medium/src/components/DraftEditor.js\":\"16ad03ff978b239b\",\"/knowledge-medium/src/components/GutterPill.js\":\"b847c430c7b53edc\",\"/knowledge-medium/src/components/Header.js\":\"bf357c52c813cc25\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"9209e8cdfac85d34\",\"/knowledge-medium/src/components/Login.js\":\"1faae310aeadf24e\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"59ae7727cc3b7397\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"bb413ac3f4361c3e\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"384e4230a37eaff8\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"8f30f04af4062d61\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"62a7b7b829ba478f\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"6c081b1e72f7a386\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"f9fd9f6741508bef\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"94ad9d750b2b4dc3\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"e9edb0fa836d5350\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"de4cb86ffa044735\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"c67ea93783252e30\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"692c771614c79b9a\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"07c380d2682e9ed8\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"b11a3a19c649dbf1\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"b1a132b71d62ab15\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"42069cdb70573f7c\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"1ccc33a3d6d3645f\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"ec2cab96c07de933\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"d32e68cd85da1054\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"ce68efc1954f3193\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"218a2f35d1559183\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"069334d8a3b390f5\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"b317a55d8c0ca38a\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"7b28623827f8e54a\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"1468c13e974e1fcf\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"ce720d9121fcaa6a\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"0886095b8994d7c4\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"221868b8a39fd3cd\",\"/knowledge-medium/src/components/references/CompactReferenceLink.js\":\"9efdd86a87e5a97b\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"3c69fe604e1104e4\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"e1f19219918b8994\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"d5cf010ab4d04932\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"549a6ec61c4039f2\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"5a72b9718f4cd160\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"ae535fd292095826\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"d91fdb5e06d1c25f\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"5153370f9b109582\",\"/knowledge-medium/src/components/renderer/BlockReadText.js\":\"f1c61a4b7f53b8a1\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"c19c36a3496c5220\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"558b608e837f508d\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"a3947a9f740d4eb3\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"5432d67d28dd2774\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"18d864871972260f\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"d547eec17bf9b623\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"9d008c5cf288ed8f\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"8cf694a63cbe316c\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"458e0d57691a123f\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"40f2b42f2676c44b\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"53378c5262f6a310\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"40fd1c6857e5e191\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"947b87c77a0b0f6f\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"d7e6ac8eb0adb6ef\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"b5eff56f723900db\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"d87f73391a77910e\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"1cc8b79f900bad3d\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"6265d844d86bf18c\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"50e6218a1d7f7304\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"6b22e779f32357a3\",\"/knowledge-medium/src/components/ui/button.js\":\"3ac6c4f4d01f4471\",\"/knowledge-medium/src/components/ui/card.js\":\"ac5c3c2cff63d366\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"8b6fe6d46fa81afe\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"d4716cee83f0db96\",\"/knowledge-medium/src/components/ui/command.js\":\"76c527088e0f358d\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"054ee00594b2b958\",\"/knowledge-medium/src/components/ui/dialog.js\":\"661dfaac4e177cbe\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"412ae3039de7c3cc\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"5741eeb6a6115c79\",\"/knowledge-medium/src/components/ui/index.js\":\"dafae56b18231cfa\",\"/knowledge-medium/src/components/ui/input.js\":\"819fc2421bf0787c\",\"/knowledge-medium/src/components/ui/kbd.js\":\"7f2965dfdef76278\",\"/knowledge-medium/src/components/ui/label.js\":\"a930753f19a05706\",\"/knowledge-medium/src/components/ui/textarea.js\":\"59e05d62af8c12f6\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"95522042a1788c8b\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"0520272700252001\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"547c6d111373ec76\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"ca4bfaa47bdc74c2\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"b4b587dda2bdcf81\",\"/knowledge-medium/src/components/util/error.js\":\"a4a3e861bb5c9d0d\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"1e5f83c4c34e3494\",\"/knowledge-medium/src/components/util/suspense.js\":\"6523851725720f15\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"0476f629f2ac4ab0\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"960d6691a30a79f3\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"91bf128798d16960\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"7dd8682e8b225071\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"a91e1379a758c8a4\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"b3415bb16ea20684\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"eb448711d222e5cb\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"397b8a290a9eb328\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"d030baace1946722\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"5508da7cc90405d3\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"230124b2a96cc125\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"7ac4e522dd9c4914\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"4ef254939a2ff5e6\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"1ddce752a38ffa8f\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"5442c0d3aa27c2be\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"cf811bf8c01629bb\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"662436e898d673b6\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"2968d33ae407328c\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"5896a288cb16ec9d\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"3d11698de4878b9f\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"4c4d762b360d8ba5\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"0d5fb2e589c290ed\",\"/knowledge-medium/src/context/block.js\":\"9d6f7364f0a344bd\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"0d89822b2c5ebbe0\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"42c4fe2b34632985\",\"/knowledge-medium/src/context/repo.js\":\"d05f9dcb1285dfeb\",\"/knowledge-medium/src/data/aliasClaim.js\":\"99c29b31f4adf26f\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"c7f1ca7ae5af01c8\",\"/knowledge-medium/src/data/api/blockData.js\":\"f8027ed6d3164155\",\"/knowledge-medium/src/data/api/blockType.js\":\"ac96888d642596a9\",\"/knowledge-medium/src/data/api/changeScope.js\":\"bc8e6f402498ed01\",\"/knowledge-medium/src/data/api/codecs.js\":\"770cbc963b6b9b76\",\"/knowledge-medium/src/data/api/derivedData.js\":\"063ca5ae5fe76e56\",\"/knowledge-medium/src/data/api/errors.js\":\"fc2fcd8129837b91\",\"/knowledge-medium/src/data/api/events.js\":\"fa1a5c443a9cd722\",\"/knowledge-medium/src/data/api/handle.js\":\"cca869e14c55001e\",\"/knowledge-medium/src/data/api/index.js\":\"9d3b2401b2319b98\",\"/knowledge-medium/src/data/api/mutator.js\":\"82e81de56a049de1\",\"/knowledge-medium/src/data/api/processor.js\":\"aef19f28a40bac77\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"c7ea50d0d44327b4\",\"/knowledge-medium/src/data/api/query.js\":\"7d27baeaf6ce55b3\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"a45ac2c6e8ef1287\",\"/knowledge-medium/src/data/api/schema.js\":\"cca869e14c55001e\",\"/knowledge-medium/src/data/api/tx.js\":\"cca869e14c55001e\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"5e0e2c390e492bf1\",\"/knowledge-medium/src/data/api/user.js\":\"8fb81909e7d1df27\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"2e73a127192a5270\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"a04199434d2d6cfc\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"2e0ffde149a08b11\",\"/knowledge-medium/src/data/block.js\":\"bdc4a43468f6b829\",\"/knowledge-medium/src/data/blockCache.js\":\"019905faf35e8951\",\"/knowledge-medium/src/data/blockId.js\":\"36ea127a543f315b\",\"/knowledge-medium/src/data/blockLiveness.js\":\"d2160f3a9b6bb601\",\"/knowledge-medium/src/data/blockMerge.js\":\"e2d91f583f083aee\",\"/knowledge-medium/src/data/blockSchema.js\":\"97d4fa7663f8aa2c\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"fee02ea5b5976795\",\"/knowledge-medium/src/data/blockTypes.js\":\"e9c15bbe1646f9dd\",\"/knowledge-medium/src/data/childrenView.js\":\"91bd76d2c8fafeb9\",\"/knowledge-medium/src/data/clientContext.js\":\"1989262faed0762f\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"9f155f0a0e0a8877\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"f4d2865e0dcb2fe1\",\"/knowledge-medium/src/data/derivedIds.js\":\"106ed1a7fdd48c0e\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"db0c9dbc024bf3d7\",\"/knowledge-medium/src/data/facetBridge.js\":\"6a9c04304df812fd\",\"/knowledge-medium/src/data/facets.js\":\"69fb9ca58ace1523\",\"/knowledge-medium/src/data/globalState.js\":\"cc1d61447811e7fa\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"a4b6558af0013080\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"17933edfe753c727\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"9386f09c1c0d7d96\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"bf2e47befa685bb6\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"f7ae9ac64d0a13f0\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"4735ccde5499a36f\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"ae42d685d0007557\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"bba72e53c2657935\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"eab16c278e68def2\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"a286b336d956894a\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"5f3ca831a828b0fc\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"9e3e636d3d14ef85\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"7856f185ec858c04\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"8f244baa42b4453f\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"a743d139bd24e002\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"8a55c067ebafd666\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"f263ce65f62d609c\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"3c8cd5f889bb227d\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"0255803ee3b93ae7\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"660653b9e00049e3\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"c1b2fdabec259e30\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"f51747f4bc0a5680\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"6837c6d8bc171d41\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"2a832942036515c7\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"03d57edc288cecb8\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"c9c1e6de32a6d4cc\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"fa8759e0f69719fc\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"f351e3a029d66351\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"568e2e9baf05262e\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"dc12e48f42b6371f\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"8eee590c6a94652c\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"83222b5ab0c23b2e\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"525f19701f287a38\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"c67a91503be6e3ee\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"ca5327d231fa2a55\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"d219ebb0f9bcadfe\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"75e9302dd5759f05\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"a763cc124d22fbe1\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"f9d267684d917ee1\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"3d4201f702a0ef09\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"eea755c69fc16e84\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"aaec1956d15ea8be\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"0e1af4c424c2393a\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"94856857bf6da824\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"ebe57ac9fa3e1dcd\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"004769ce4e01bdb9\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"014544f75856546a\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"2a83aab441873ed9\",\"/knowledge-medium/src/data/invalidation.js\":\"12c77c685305af21\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"9e3af21466d115be\",\"/knowledge-medium/src/data/kernelPage.js\":\"bee672884fcc8a41\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"ce345bd5a069e4ce\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"7c1fef1d596724ef\",\"/knowledge-medium/src/data/localDbStorage.js\":\"315032b253bde142\",\"/knowledge-medium/src/data/localDbVfs.js\":\"cc4bdf303135785f\",\"/knowledge-medium/src/data/localSchema.js\":\"41922922ef289738\",\"/knowledge-medium/src/data/maintenance.js\":\"32d5bc778e958269\",\"/knowledge-medium/src/data/mergeProperties.js\":\"3d38b59de24086f2\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"fd189a759c4d1b7d\",\"/knowledge-medium/src/data/migrationsPage.js\":\"e4499f7f112e72b7\",\"/knowledge-medium/src/data/mutators.js\":\"48d2c32fd49b6aa3\",\"/knowledge-medium/src/data/orderKey.js\":\"1656a87db79cebd5\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"a23dab520683b571\",\"/knowledge-medium/src/data/outlineSurface.js\":\"4ef864f4bc5d9229\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"ddcb7e15d25b4b8a\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"f607fed244b96de5\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"dd2ff3b8a49c05f4\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"dac4e50033814a18\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"32ae4188262b588d\",\"/knowledge-medium/src/data/properties.js\":\"4eb5551e7e2ef318\",\"/knowledge-medium/src/data/propertiesPage.js\":\"20a0b6205dc12481\",\"/knowledge-medium/src/data/propertyChildren.js\":\"0f869f4225b02199\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"3d0bf5682a75f959\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"23293e702830cf9a\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"bacc1726b48f97f4\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"b85db25e6092f41a\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"e4d9114c9a294bac\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"555ad6195eb51adf\",\"/knowledge-medium/src/data/propertySeeds.js\":\"9607e89842e9784d\",\"/knowledge-medium/src/data/recentsPage.js\":\"33e585a5a50909b5\",\"/knowledge-medium/src/data/refTargetComparableProperty.js\":\"6f31efa7a0ffa5ae\",\"/knowledge-medium/src/data/referenceBlock.js\":\"e93931467c2658d1\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"191da5f1622a0acd\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"5b870e8b435319ce\",\"/knowledge-medium/src/data/repo.js\":\"5708446b49951edd\",\"/knowledge-medium/src/data/repoProvider.js\":\"f0abf15a8375dbad\",\"/knowledge-medium/src/data/rowProperty.js\":\"0ca1033f824f32d6\",\"/knowledge-medium/src/data/searchFilter.js\":\"b09fe772a2e34c9f\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"56b165b36f871133\",\"/knowledge-medium/src/data/stateBlocks.js\":\"a389ab01e9d7c2d8\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"23314260d8664f77\",\"/knowledge-medium/src/data/structuralInsert.js\":\"405e587560bc7870\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"1e6a275992698de6\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"cc15eca99223e0e4\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"de05746cafdd3e83\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"3994603d010b2148\",\"/knowledge-medium/src/data/targets.js\":\"919dceff30bd2585\",\"/knowledge-medium/src/data/typeColors.js\":\"e130447dc316909b\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"35391338ba8c577f\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"d8532613052b0583\",\"/knowledge-medium/src/data/typeExtraction.js\":\"3721cc88e380c14b\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"df3576088886ed14\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"0740cb3d71e7e5ca\",\"/knowledge-medium/src/data/typeSeeds.js\":\"a2a09aed0058e29b\",\"/knowledge-medium/src/data/typeTagger.js\":\"db5e0e9a503c4abc\",\"/knowledge-medium/src/data/typedRecords.js\":\"a0dd3c5ca1be77c4\",\"/knowledge-medium/src/data/typesPage.js\":\"bffda8134b3f237a\",\"/knowledge-medium/src/data/userPrefs.js\":\"3e0605df160156bb\",\"/knowledge-medium/src/data/userSchemasService.js\":\"341a8a0c49e754c7\",\"/knowledge-medium/src/data/userTypesService.js\":\"62819a5bf1d05122\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"d21b36936420a32e\",\"/knowledge-medium/src/data/visibleChildren.js\":\"31958c228900415e\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"f008eaf27e425c4c\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"a208ce7a76ba07a8\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"e5ff815454e62915\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"3ebd861ba827aaee\",\"/knowledge-medium/src/data/workspaces.js\":\"f9eb608f5a4f2492\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"f7b63364bff36e15\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"5aec5c1a1a031970\",\"/knowledge-medium/src/editor/atTrigger.js\":\"1ddcbd7d0f27065d\",\"/knowledge-medium/src/editor/autocomplete.js\":\"d9709610dae243d0\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"88ed218a917f8088\",\"/knowledge-medium/src/editor/contentFlush.js\":\"23a4bc02361faf1f\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"169df46ab2e7d2bd\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"a93554d608426e79\",\"/knowledge-medium/src/editor/insertImage.js\":\"3768086be7e5c199\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"23c6332d1a132a74\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"f77cf3a37ff330a5\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"59984aa0d8d87f61\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"593eee75e8dc9200\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"eb03ed1d24b56912\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"03410bb4f0e184c0\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"9e2754945ff9054e\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"376a7a821524103a\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"6aacc37cc1d28758\",\"/knowledge-medium/src/extensions/appRuntimeController.js\":\"bb4d34ba317aba3c\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"225b7295cd6279d1\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"d21911f86e495c5b\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"29dc3346057df2d2\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"571950dec1b12fd7\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"781209163e1e0aed\",\"/knowledge-medium/src/extensions/buildApprovalRecord.js\":\"a446360750e50631\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"8327539f5d6e2e74\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"47c765b8d1c1df59\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"2c438b9508764954\",\"/knowledge-medium/src/extensions/core.js\":\"f47ccb36073bfb8d\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"38582543cf5c4a5d\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"d239f7e60a13a4e4\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"894ea75d44dc8868\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"a8e3439d185badf3\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"5a3799a3f8e95e15\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"8365eb2047346cdc\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"abd79e5e82931de0\",\"/knowledge-medium/src/extensions/extensionImportPolicy.js\":\"ef184ecc07e9a245\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"3a1718754fbeffb0\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"2cbad27445c7db20\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"3b572672724c2aa7\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"346b7497c86e04db\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"3e0c4263bc6467dc\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"bbe412dacb731edc\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"91ad6a3b4345fec0\",\"/knowledge-medium/src/extensions/normalizeExtensionSource.js\":\"f23687baed7cac3f\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"7f456950996cfc65\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"3e85540c5b4dbee0\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"0bf9a09a7b357c35\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"5461f543e3b73515\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"9f7a75f1d89fcb93\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"e57fd411f287e5e5\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"3353080ea5d44384\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"1e00bf57d91a1060\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"2fc752bb163079c3\",\"/knowledge-medium/src/extensions/transpileExtension.js\":\"e5fccd1d12aefea2\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"f171432408408610\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"bce16a8c25f10674\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"9d27b2950a7095b6\",\"/knowledge-medium/src/facets/facet.js\":\"507e389e5341808b\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"5d7e8ec482922fd7\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"5ae49e22e49c5922\",\"/knowledge-medium/src/facets/togglable.js\":\"174a0894986a35b6\",\"/knowledge-medium/src/facets/variantFacet.js\":\"4b7d9bf3120cbeaa\",\"/knowledge-medium/src/facets/verbFacet.js\":\"3e4aa1de5e0f573a\",\"/knowledge-medium/src/hooks/block.js\":\"0a5532f25392b232\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"7718a8a55f2eedb4\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"cde2e7b49165316b\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"699aa0a144403993\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"ee2541331f641427\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"9baddfad6a268f4c\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"1975e809bb73d80a\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"a4875bd197f7b148\",\"/knowledge-medium/src/hooks/useFacetValue.js\":\"dabf1eb2ad8e2487\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"9ed5185e15d68d16\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"62cfd8d655fd13e0\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"6fd57d05ab3f17e1\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"791343b82eb1dae3\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"d5ddfee4f9c24b61\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"8dcb5f0068e90e39\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"2513af9801bd8aa0\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"fa43dd724fcbd181\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"2093fc13666d352a\",\"/knowledge-medium/src/lib/utils.js\":\"2ce31adf080030e0\",\"/knowledge-medium/src/main.js\":\"e06b7391c3c5f482\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"f6c4086738a5b3cb\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"93a7a641b2ada2a1\",\"/knowledge-medium/src/markdown/context.js\":\"ef91d78a009eede6\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"3ec03bd51b8ae557\",\"/knowledge-medium/src/markdown/extensions.js\":\"8ae80ff406e826f4\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"daf2705ef9639270\",\"/knowledge-medium/src/minimal-editor.js\":\"9028225f7d3230ee\",\"/knowledge-medium/src/paste/armedCut.js\":\"6f891899911ad7b1\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"4a474cdc1220b471\",\"/knowledge-medium/src/paste/clipboard.js\":\"e840ad3977ecd617\",\"/knowledge-medium/src/paste/decision.js\":\"8b7ccf3bb2dd3cb0\",\"/knowledge-medium/src/paste/operations.js\":\"168a86d733e4c96f\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"1ab7bed07e713de0\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"2f0e01bee97c8edb\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"64c6db9e5e4db2dc\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"fb0d29fb015577db\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"9b8b5f0fbad88f7f\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"b1e7a8e0cab83073\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"4cdae34d230f9607\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"5e40627d49d16a5d\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"0e1db44433223260\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"64965d273a10c637\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"40c04f53a72b8d3f\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"b72a16e6a354a62f\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"574a523e2fa096ff\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"82ba493d5c5e37f6\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"3d5ecc98fa6d5faf\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"29e105e0f9e0a52d\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"d39b291fdbd3f952\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"df51f1258793c388\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"1ec0e95507f2094b\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"3b8fe7e212cf4cff\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"420424d1c646af4a\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"74c30eb5706ba3fa\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"fe7ab144d3f4b6e4\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"8e5a0b186018bb61\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"315c57ef1bfb69ea\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"091c1f269df3e246\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"ee9c4a6cf210c6b0\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"c80ca5f694eca1c2\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"2bc307facd436a97\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"cc50698287275bc9\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"1f69f907be07d472\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"b0d856879a776fcb\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"9104fd31a5bd555d\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"7a82d56007acb48a\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"1d1d345241b659ad\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"df531a7d8b208fe5\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"d28a99aa5b1768ae\",\"/knowledge-medium/src/plugins/agent-runtime/dayPropertyInputs.js\":\"04404c7ce8e66b47\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"9fb9169b88f20d78\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"9bcbc68cf83eec5e\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"ab8e9d7f4b3f39ee\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"f05e53927475ca51\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"6c82f7009d0a1041\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"a42d1092626c4196\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"0bbce34cbb716082\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"d8935d2b4f4e0830\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"43f7c761ff708608\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"6ed1ca8dda47c069\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"8aba0e591631b766\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"64a9f00233b03673\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"e82fabfb73373c8b\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"a3386b22117a37a5\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"4e5245f9222c8bbe\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"45cb68b56f37ef56\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"826a924959336959\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"75520488a5a35198\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"1093290f1bbcf45a\",\"/knowledge-medium/src/plugins/alias/index.js\":\"4ffda2d1ff113843\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"d71c849e69873630\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"6fc19eddc0e790cf\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"09a7a831d5508dc5\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"2670b9775c0ff131\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"3aead64e8e021582\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"54c6ddd4d6d6471b\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"c646ce664234d0b5\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"1f8ae5591daf48c3\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"66bdf328eec2a709\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"520431bb7ee59a63\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"4d945d697f92cc52\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"0718262aa6fa093a\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"c88d95e5ad23b604\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"3ab746944b3b3707\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"e2e09260ae5e7d0d\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"e33666a147b75eb1\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"b9c5b82f821ba75b\",\"/knowledge-medium/src/plugins/annotations/marginAnchorLinks.js\":\"ae1ecb42cb4888de\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"02a70e79283beea1\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"401b055643499c2b\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"43797701053b3438\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"7abd3e0238f0f214\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"cafca15454c1924c\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"1afc679b5cd2b8b8\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"e48936ef0cdd693c\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"ca87400e18516c1a\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"5310eb042bb342ab\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"18c4ffa4eb426f28\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"746d3402239d70ad\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"0980eac15c43241a\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"7e0c2129ebe44893\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"2a67796cfa60b669\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"ef5c29cd418d4b22\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"96859b1c7a2ee13f\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"f75d70b0256427b3\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"e2c20335791044ea\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"d29345b9bf932f9d\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"9f2a4c95ec4e0e32\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"6a562d85d3cbca4b\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"afde05618807ccb6\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"3d119c0b521b5471\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"b38720af5ee9c633\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"8f864ebd47055b02\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"29435363a112052c\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"e93772bc2bba4d68\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"956a34006333c15e\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"2648d4b669edcf6e\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"1f0c81249e08d956\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"68d3691e7792d58f\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"8151dfcb3e4b2374\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"5788073af2142f09\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"59f5bd586fef6936\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"d445eee103c42305\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"d0fdccb52979f462\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"60a01062fc01ef14\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"9a4699596599b0ef\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"44399b4a724102e6\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"91bf1fb1e2cdb8bf\",\"/knowledge-medium/src/plugins/attachments/browserMedia.js\":\"a5f5bb5826b783a6\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"37830713458ed2fb\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"0dd6c503b6f7320a\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"cc088c2518ddac10\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"f11fad125f2342cd\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"090741ff384cdd35\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"b353c81c43b75b76\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"2cd112c393973b44\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"a70b2eb86fb21cd6\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"70ede99d145fb5fa\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"eb66aeeb61aeb4ff\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"e2e0329ac2875f0a\",\"/knowledge-medium/src/plugins/attachments/mediaLanes.js\":\"df1fa6b82d8079b8\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"2e42e72995aae4b2\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"1853ebe6abb28462\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"d315cea6d53e47ed\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"cd93c38c9218eefb\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"f941f456bc227734\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"2d1eb4a2ec1250ef\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"1d9d20f47f8e0713\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"0f2fba08ebd9a5e6\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"1abee4bb20b32798\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"1d66fb8170686e7c\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"dfb47eabbb444fbf\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"74963d10b27484c1\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"cfa5f9b96b017ec6\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"3eb31af91a823b32\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"27412d3a2d4c85bf\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"d47e7c5b04a464a7\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"b480ebb32ebce79b\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"f4a0de9d20ce4a83\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"d1e82bbd79511fa8\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"34b6ea3a48dfa867\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"825aa9ea5d1f3156\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"7b13491db19f7402\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"241fe52a5ec601b3\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"d1bfd288101959f7\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"3f7f4826aa3d3a56\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"a7550bc7f67d2c16\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"618f269ca0c05c26\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"6658dae0c8011bd2\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"a61be8dda034d62d\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"6d4ae1a0ec03103c\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"1b5d9ebfdcfc22ef\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"f6675dfe0cccf3c2\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"ef85d7a1813fec10\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"f656d981e53b27c5\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"1ac3eb87c00d33ee\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"9ed40e732b67c51d\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"dff970b373c4bf1e\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"980bab0eecc574e6\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"235874762ed929ce\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"e83c1c4a7796e980\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"9a444ccd77fcdb7f\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"2f7b99cfc8dacb59\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"c59c7ab7e9ed3195\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"ffa86800f95eb6d6\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"8883c614b9328e7f\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"2a2849bfb63f44d8\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"09705c27f506a41a\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"29939a1a749eda9e\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"946575342e84dd3c\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"37f0c6573a42132a\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"5f011cd40f804400\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"d627b32797d821f6\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"3274ea7bbe3ee753\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"14c21470639774cc\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"3435d2a67edfd7c0\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"4efa8051c0222e2f\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"a000bb8e6245841d\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"764f6a01ee74259a\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"1ca767093b71a6de\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"b8c6d298e3433de0\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"43442dd1392ca9f6\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"bb3be271584efcde\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"fce47f667350ba5a\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"48eee046893a2e94\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"dc2f0613b1bc17af\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"d301b9d89a2d7653\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"832328fcfaa8ae34\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"55c4191b8f5ff15c\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"3e88388c8f790fcf\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"1a33ac14af5c7568\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"1710afc1f2ababcf\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"4748dd080e00a1cb\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"cd723f5a34877918\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"0bf7ca21ce295174\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"0a0a8366d4ae84bf\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"7ec26cbbbab629b2\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"25b2072f48f3eb6b\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"088d970e4c968c60\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"351207a4700be8d7\",\"/knowledge-medium/src/plugins/character-counter/subtree.js\":\"184c9e5be3836b26\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"ac1b72a8c6c92710\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"e421bd4a0f853b94\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"001594e209c2a4ae\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"2b10992a60624374\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"ec64a0f080f8bbcd\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"9f77c2e229daeccc\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"c8c3a8bc3bcf2980\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"749206fe8219e3f4\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"500be3bcf6f088dd\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"0b37d5215e789119\",\"/knowledge-medium/src/plugins/contributors/ProfilePicture.js\":\"5d4d0188b6edc36e\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"d4de534683fb678c\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"7b32764d3c33c774\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"8a9814afd09e133a\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"f9f123acfa1f52cb\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"215a3e3c58708314\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"e5bc4b2f8ec1a62c\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"bd95868cf5787256\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"b43a9050dd9da40f\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"b173422ebd874b67\",\"/knowledge-medium/src/plugins/contributors/useCommentAuthor.js\":\"d36f25f243b91045\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"e6d156bad543d3e9\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"71c2338a9c2e6c5b\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"7b16bddf23aab001\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"17d005ace5ea48f2\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"b1f375814abce377\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"5dd2ea29afab9818\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"2ec780d4b9a5ca95\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"e6907310038a747e\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"5688b4625b8673ec\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"5c79ac00b043beb6\",\"/knowledge-medium/src/plugins/daily-notes/DayPropertyControl.js\":\"2811879d44d3c133\",\"/knowledge-medium/src/plugins/daily-notes/DayValueReferenceControl.js\":\"bba7e58500a9c0d1\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"e103ed646febfb9b\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"6e023a4d00682725\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"c643890a5653e289\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"f423fae982d682d6\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"0b16335c8918ddc4\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"3c95be7793c3d244\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"6c4a3c05709b7dcb\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"18bbd84620ff64c7\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"cd633f3a6bf6f808\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"cfef745c9933e002\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"59dbaf9a0e5422fe\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"d01db03bdc339eec\",\"/knowledge-medium/src/plugins/daily-notes/dayProperty.js\":\"1104d044d6bacac0\",\"/knowledge-medium/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"1d94e9945a173b02\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"1b7b640b66c4a4d7\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"3b883250dec26893\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"b2d59ebe31ace537\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"1de1811a4b04c999\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"3b91cd3fc4d8c92d\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"f1d3affe6ce176c9\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"c8c732812339c7b4\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"407ef571c515cb9a\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"cdd9ef850aacad62\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"20c52d956b321aef\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"73651761723290cb\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"1d5ddba3a4dee3f5\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"4e65e127f594a8d2\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"e6ce145115d3e1de\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"6431aa2d83ef188f\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"105c4267e4c37d48\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"bae0f21158f223be\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"9f42653b2ad804ca\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"609a43189286afa3\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"082328783e73fd5a\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"51e24783cd653507\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"94e679d180841ede\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"a18b34901dc6f8e0\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"f03959ad102806f1\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"95372da82b1cd44e\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"3e38cf528944d46d\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"b7ccde2885fbb59d\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"be63bdb86ea1ee59\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"5774e1cb98fd765a\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"461d24803979091d\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"9b8a9fc29123d4d3\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"809d2b4e409aa9cd\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"414c45d99d8e74e3\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"ccc9da0451d36728\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"a1db3a0fa2bb0b7f\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"13231ba043b92995\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"87f4980cb5ae5b25\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"ee51330028343a21\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"4f22b8565841ef2b\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"1760180d3f3183e2\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"b3034aaefbd7e8fe\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"8a2f35a90af04f9c\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"5d01f52404c870d9\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"d73cf371e1a35273\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"d2649fb8db487749\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"355280102514a513\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"306b278585f5cd6a\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"6e911a6cf9036986\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"9ba2ef7075084448\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"fd8e991a242756ac\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"995533594943c840\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"57f61489ee276a15\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"e3bd3e236c28e3ec\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"8594894aff6eb2e8\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"59d1f2c7d5200361\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"cdda1d5f4c55c55c\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"ca43a59c24722ea6\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"fb46571edc496c65\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"211b65b8ef373eee\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"8d7f207b2faecdd8\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"fa67ee62ec8d89bf\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"0d0ca5d0b78134bb\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"a5abaf3df0f7ac3d\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"b9f470dd319b0416\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"8fb974fde5c8384d\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"d2e4595ddc7ea3e0\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"c7c73b8389e6b4bc\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"f55c87fb3da2f16f\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"d2385b671c321289\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"24c26059b10ceb4f\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"0e27b9200601107a\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"6d8d0eb8d7225954\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"b5a5c1b0d5337d4e\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"09bd3640ecc32ad3\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"85bcee42815a549d\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"88fabfadc3720859\",\"/knowledge-medium/src/plugins/geo/index.js\":\"3af2f2f50210b35c\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"7225f4b729c2f784\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"f94f209f326c39b2\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"d744ae1d1be099c0\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"76044af9f676797b\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"24d4626500422e3c\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"20aff663b5393f91\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"a43b6f5f1540fc5b\",\"/knowledge-medium/src/plugins/geo/query.js\":\"db99700e8f06b584\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"1c21f28d8a004803\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"9749b4f8d8267b76\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"d3842916b41989ac\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"49ca4ecf87c30e9b\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"e6aefef04ed3cff4\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"372a1d6dfc675ff3\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"4d8c1c1edebf7748\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"259d9ca09a9c8014\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"2015325700d18223\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"59609c1e0d14430b\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"ead9b9398478bba9\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"941874858c48c8e3\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"063b03f899cd16ad\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"db95949304821963\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"ea7b1f67f929413a\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"a2db42af9ccc8a53\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"b5aaab00d73cea1a\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"500e9f29abb4e84a\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"1edb81d7bfe774df\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"b787a17c24ff505b\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"a2f143eb57c0fbe0\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"e4d60a19122e544d\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"1148e86e1444fd6b\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"b16e1093a22eb602\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"b92ff3f9052a356e\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"5c50b80aa0b65ffc\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"e4fbe8e326717ef7\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"324fb812e96e387b\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"334c2979413de6cf\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"8f7868d002b31fd9\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"625bc24fde7dbeff\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"516840434bbde1bc\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"bfbb6c5f73710e41\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"be035d252d8a3113\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"a397cf316283fad3\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"cdddea050c4b2ea8\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"d4433a6fbeae9bb5\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"a6e70605c21f278b\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"c8c5f386e68aaa02\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"fa96cedfcbdb3468\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"fb2365dfbd30518c\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"98c86c1cf91550f9\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"72a51eb376bc1f02\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"2800ea45aacb786f\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"758e17f60f77392c\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"f4d8c4585cce36bd\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"5df1e8cea2333d60\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"61bb61e35d918d8f\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"450e9501967cecfd\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"f09f2380fc829ba3\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"4a93e13ab5469253\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"5f83cb9d98b9046d\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"af072711b80c5e2f\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"27da38005274e5aa\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"f5679d0c02a09e31\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"6a525b472cc80a76\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"39eecb7395b29c00\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"871115aa1c53b0e6\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"659b7c7c75b061ae\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"1b8aa0c9a00b994d\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"71472bfd5cee671d\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"20cb183e2bce444a\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"558a43ba32b6a0be\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"4df669d40647b426\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"f84a6e93f5c0aa2b\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"c6256e094893c6ca\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"43ee11c594732e7c\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"03b1f6abac4b9d86\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"a8b4f216f2699c74\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"d772c68571cf325d\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"ddc3e44a965c376c\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"96a203aabb9a467e\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"f4d1a6f6ad736771\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"28601d895d641d22\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"5c3ebf35b2b67d7f\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"15396fb687853db6\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"62e06420e4db93e9\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"9368d9e1118bc84e\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"25e9ca9d767d17fe\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"47902387fbe42225\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"92a9ece9932575e7\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"b15e3b0f08133358\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"f2a959bedcd4d07a\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"493496b485bfcc2e\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"b6fdb57966cbf20c\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"e71dd325b97104b9\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"65bb1fc893e2dc9b\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"13ec340ab26b171b\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"f6a2f7c37fe0b12f\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"daefce506bf17eec\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"6a66428d66a824ae\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"c246b7665bf942b7\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"a83a0f6b8d235738\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"f8b9aa24f82a7dd7\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"68ced40dc61d8d45\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"04936b499d069d1d\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"7d739d59ab33a13f\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"6456da14d00c85b9\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"a9dc45100ac0334e\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"c2da39c64cc328eb\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"b16f5cc7ceadf254\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"048320e969f381a1\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"57352ba399fc573a\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"1cd882074ee3dc25\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"460a48ffa0881f77\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"3cc7e055cbaed963\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"3e7787d5dcf59f5f\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"e5482f60d70eadf0\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"2921c03041b9d080\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"174806aab3e66e27\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"123dff40622dcd2c\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"6f5372e1c995d1f1\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"1f49c3665025403d\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"a87dd44511b969f5\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"bcb79b12127ed87a\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"629ddd223a034393\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"f8810d22a5db14ed\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"4b912a1201fe7e5f\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"8ca05f22ffb6fe4f\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"a7510b66e370d3ec\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"26db31cb0f82cd13\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"278748dcd34dbf3c\",\"/knowledge-medium/src/plugins/recents/index.js\":\"00348fa0b80d31a0\",\"/knowledge-medium/src/plugins/recents/target.js\":\"c9d6ab413a0b0b2d\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"e4cefdb109492f9a\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"029a00b1d5c71dc2\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"5e85f75531dc67f0\",\"/knowledge-medium/src/plugins/references/index.js\":\"e5d036c2d6ba1c33\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"abade5406f51f7ce\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"5d1147ddb84a6b23\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"7eb080361aa7c031\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"dffea56cad717de4\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"84e710f1e1e8557d\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"34e147551aa2ef99\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"3cdca324747c0082\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"629fd97262b33fef\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"a1b7e4977aca7cfe\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"057e01d176528ddd\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"d68a61bfed5eafce\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"190190d6ea46bbb0\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"61172dea92f8aa3d\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"886549529aed802a\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"ac1c7db694be8e63\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"59ed87755007d7db\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"99226db2db23bec1\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"451781136b43fec1\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"f79afbc6369ed14e\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"36b75a4d7f418e71\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"74f782d835c9f880\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"a0a03cc173541f0c\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"daef185b3ad4cfe0\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"31a30b660d40b706\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"03656f12eb88bbd4\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"8de9965c41249959\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"e95cca84e6a795f2\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"5a827df1cacac7fe\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"290db9fed46ee06d\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"35ec31d44dbecf2f\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"008f327483e3285e\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"167a36c3e7bf7824\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"67e74c9472f94cc7\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"9c78d7f4ddad6f1c\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"da31288ebb094bf8\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"594be3bb93b36f1c\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"dd23c59e60053985\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"d8f1de12cc22b9b9\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"80774288e9c837d0\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"adb8f11468cf284e\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"82176498e7d2356a\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"dbe68281c37db190\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"ce6a1b966102de71\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"59ccfe49e5c52a0b\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"12576087aac84d14\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"dded72d4be24c880\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"ab564c14b557f0d2\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"f2eca7b1ec73f070\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"c396a89f0eda38af\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"f387527387e57146\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"5aa1dcc13a02f406\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"8c13688cdc881433\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"169c40dd2536c65e\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"185d9ea719a1c066\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"579568aa34b08008\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"c9fd36c0ab15ef87\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"6048e4ee37764681\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"a19618958ec1ea09\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"4b1a7d64b775663f\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"d4f3fb2d83b6bd16\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"385e8d5aeeca58b9\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"1c50a9a5720e6ecc\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"ee926ec89964af44\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"ad55be0165a9d6c2\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"12f766250c2cf4c6\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"603769d2ec418349\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"4690b59c34506d39\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"619a01ed3d0d17fd\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"db4eef3685cad1bd\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"2de2316c0f191ace\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"88f14f1a2b750750\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"f30dc146b4893625\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"a1e7eba9a0c46c31\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"cb1affe1e90ea822\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"22e36445db2c2c31\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"3f3bbfff2355caa0\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"6c857ad021bd8d64\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"fb0b706bbe1a44fd\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"2df1d77b5b805cd6\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"2b2172008c33443a\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"2b0c2794353c3a51\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"90b05438b6ed8dcb\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"5d13902199a390b7\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"9abd127bb222c994\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"89382774c72514dd\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"4f7484c305c6ef99\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"4ac006719111ad47\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"826a8d32a0aedd43\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"35dc799c81c4189d\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"7c70dfee6e672a20\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"5d1add380ef8438e\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"affc2fff85a7bc5f\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"73e6a787f1976b87\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"7cc5acc59e22e1e3\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"c9405e0f83a41b70\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"cde769ee455b8847\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"dd0a056fb2b0cfba\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"33ea4c2c772a1fe0\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"ffc85da0c10b6c0a\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"10f8390b55811226\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"e57f886d90e2eaa3\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"3ca438a570004110\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"524b2297606fea27\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"ed5fa9ac4813939b\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"eeb3a607da9a7c40\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"3cf2c5d80ee56d94\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"57d6276baa7341eb\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"fe9ccac1eaffafdb\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"bfa76b8c38168319\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"be4a8f7044cd2332\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"60c439da2e1f7787\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"4c91dc6fe6a25d97\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"161cd40844565ee9\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"fbf2d1dbd7140c7a\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"29d4adb153a3cf04\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"2014614f1df6e792\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"e9114f6ba6cff356\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"bbbacdd7cf835f0a\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"78e33dc37b32f187\",\"/knowledge-medium/src/plugins/tables/childrenViews.js\":\"ff7fb2ee76f43da9\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"844c15a621a0c93c\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"69da7d1f871dca0c\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"4dd2e36dc97e9dd8\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"2e1752779378e65c\",\"/knowledge-medium/src/plugins/tables/index.js\":\"ad9c2835959c0f19\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"3eb0eb1ac961c1a4\",\"/knowledge-medium/src/plugins/tables/model.js\":\"79c6c8f015f08475\",\"/knowledge-medium/src/plugins/tables/query/QueryText.js\":\"d187a5c95f3798df\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"4a2c8f140ce9cc07\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"58e50b755ade9e9e\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"8e3b1930e1a9c8f5\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"8effdf02508e978c\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"74c7a05732d69cb8\",\"/knowledge-medium/src/plugins/tables/query/registrations.js\":\"21ce1e890ece6268\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"2741204a37706675\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"c3cfea5fc4abe6ae\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"d3147bc014a60f1b\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"e8e6573e84faeb4e\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"0bcf8cea06b1773c\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"ca120ceac1fa8813\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"82e2fc72e5fc21da\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"5521a8fbcf83000a\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"1c3c06e140256155\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"b6706451fb86ee09\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"77ebe1f6ef48649a\",\"/knowledge-medium/src/plugins/todo/index.js\":\"1335f4c84368dc0f\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"356bce43cac41942\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"7ec23fbb29a48c12\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"1dbacda769de62c8\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"9ec465595b28ebfa\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"9112325e19529ccc\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"4d9904ee20ff12f4\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"675b4517680446c1\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"cc5cf87c820be88d\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"e84f6ba0f026eb7a\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"bb655618143637b5\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"5455b240a8f67049\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"841574a17b699a38\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"efe385016d4ec7a3\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"cb5b58644f4d2dde\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"32e8246e9cd58658\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"369f1abc457aece3\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"83bc889a75f577e9\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"c274ae31ba041ea7\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"b465d9b71560e42a\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"f3589728ce067a60\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"e41f7a2c491ed36d\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"3007a69e387de958\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"d9d531cec8a96d7c\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"0f4aaa825d6a2ca2\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"c54f6bf88e789058\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"52560cdfc627d107\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"ad75f15e351c22d7\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"8aaa17404fb4002e\",\"/knowledge-medium/src/registerServiceWorker.js\":\"b2ac626e57f4c48e\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"ba9ee6a97d0b4f15\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"6421e3cb70edc5bc\",\"/knowledge-medium/src/services/authStorage.js\":\"0f1894ed60578e4f\",\"/knowledge-medium/src/services/powersync.js\":\"5fb4e05e3c8bf07a\",\"/knowledge-medium/src/services/supabase.js\":\"21482b9a9237ff9f\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"ba3bdc5b014da845\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"d42899c468844488\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"f10ce91153b552ed\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"67d2b2a04d8c0d3f\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"071198fbcdba089b\",\"/knowledge-medium/src/shortcuts/actionKeyHints.js\":\"f27a77a3c5db04b7\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"1d6e9f1fa8670a4c\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"aeb50ad76db0418d\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"234811ce48e3b13c\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"5bb7f59f0ea7d63e\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"1b3ea8585c7ee088\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"3847ef6694c896f1\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"773ef3a33ed34d71\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"072a226f26f862f5\",\"/knowledge-medium/src/shortcuts/formatChord.js\":\"1d9ac3a5b97eba4f\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"ca41e8877327c46e\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"692a6161a888d29a\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"b128ba55958b03f9\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"6c029b52593183d1\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"e338a231e5524cd1\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"e7c36c687a7637c9\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"940da10f0daa602f\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"a6bb032f42a23a69\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"59bf1fed4c7bff76\",\"/knowledge-medium/src/shortcuts/types.js\":\"563b139f33734547\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"f55310fe172eca8c\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"9276177860e54eb4\",\"/knowledge-medium/src/shortcuts/utils.js\":\"7bb35b701f099360\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"959da7785715b759\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"47e2787c749564af\",\"/knowledge-medium/src/sync/byteTransform.js\":\"00e16ede1baa0041\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"392a18d104dc1e0e\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"f5c51c86701994b2\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"90d2f92e5e3f7072\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"7640f898f2adeb6d\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"c5c65ce6e1995fe2\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"7918ac9f2c732fe2\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"4a2cbb9681a7af3d\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"c0f7b56c80ad55e7\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"e8c70bf573a4e3a7\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"b9751332decb108e\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"505a4c6b8991fe76\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"6c7e7bc25af01fc0\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"6a93af88a0422236\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"3b07c79b6c08923f\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"ef14b5426c6a8fa6\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"9dc28954938286dc\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"5aced5f912bd87f5\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"7cfa2eb7b7c58a7d\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"6a80255d7ccfdc3a\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"1fd6627f874787d6\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"28f3a93a54271664\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"7be741c86eadf7c5\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"e9319412b17dbb2a\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"b3fda9d3fd63bdd0\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"e859cd84dbb21f21\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"159eb6b5c67fbf89\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"184f167f16136643\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"b42884dd28cc61a3\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"e8e19386b5ba666b\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"8fd270613ec63b61\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"07ae674cbd119f97\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"44dc34e1c8cc2c03\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"719b14dac26ab815\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"901ff5496c8261a1\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"a07e98042d08a495\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"9d91c3947e0f6c43\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"09d28084a497129f\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"952a613cf4885757\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"fe9d4d982958d933\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"0966a494b738d329\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"e9feebd5393024ca\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"521bedf377948b16\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"102faad44fc6ee64\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"0cbb14098ce5794b\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"0f7d8762343d2319\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"69b9585f96e11427\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"a50e900b6eebf73a\",\"/knowledge-medium/src/sync/transform.js\":\"eda98fabe8d3346c\",\"/knowledge-medium/src/themeBootDefaults.js\":\"61d451c24fa2f86e\",\"/knowledge-medium/src/types.js\":\"f8cc8f547836e61f\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"ed79fc7b588c42d7\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"a815ffabf582af4b\",\"/knowledge-medium/src/utils/array.js\":\"62684dbe26205f1d\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"85ff6d1f69b9b9f5\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"576052b46f480c44\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"e5aac6865097f272\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"201f9ba090bff326\",\"/knowledge-medium/src/utils/callbackSet.js\":\"18313ea410ebd96e\",\"/knowledge-medium/src/utils/clientId.js\":\"aad857f4fdd555d4\",\"/knowledge-medium/src/utils/codemirror.js\":\"a349f329bfd52fd9\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"c860812b660c324b\",\"/knowledge-medium/src/utils/copy.js\":\"8e00a916b2dd2354\",\"/knowledge-medium/src/utils/dailyPage.js\":\"45d46f49dedf6b95\",\"/knowledge-medium/src/utils/dbForensics.js\":\"7c93067fbcac610d\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"174e2de9692d6cf0\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"e03a47f8a110cc7a\",\"/knowledge-medium/src/utils/dialogs.js\":\"f7254ffb5da57453\",\"/knowledge-medium/src/utils/dom.js\":\"8d38b7c5086af060\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"300575829acdfda1\",\"/knowledge-medium/src/utils/drawnWalk.js\":\"a81a52623a4aa6f9\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"93e7792b2854a641\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"e6a99c7f4fa82fcf\",\"/knowledge-medium/src/utils/flipSlide.js\":\"2d23673b5e0c7aa3\",\"/knowledge-medium/src/utils/fnv1a.js\":\"7ee83c1e928fe25d\",\"/knowledge-medium/src/utils/formatBytes.js\":\"db5db0ed15a74721\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"a8f1ac029557d52d\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"831ce59ff60c47d6\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"b7a7fce3a2114a45\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"25a100dfbd5cceee\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"accf84e04721a664\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"130771077e473a6f\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"7934ad0fd2ca7b9e\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"997bb7a88b97c30c\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"48a8bdfed67c960d\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"523b5453f63b5fab\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"0dff6499c4ce86f1\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"86477670b7c38057\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"d32a20b70a3da5a4\",\"/knowledge-medium/src/utils/markdownParser.js\":\"de6564416099d994\",\"/knowledge-medium/src/utils/memoize.js\":\"9ae2b2c749b7404b\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"18b3843639bbd43e\",\"/knowledge-medium/src/utils/nameList.js\":\"c1579fea7465717e\",\"/knowledge-medium/src/utils/navigation.js\":\"83bccccb58e2c958\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"19f040902daa96c4\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"63861ba0d62ba07e\",\"/knowledge-medium/src/utils/panelClearance.js\":\"c0bbce668570ed07\",\"/knowledge-medium/src/utils/panelHistory.js\":\"2b1c79142082dddf\",\"/knowledge-medium/src/utils/panelLanes.js\":\"fabe21bb2b9436d4\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"89143283fc0a1173\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"ddbbf6766c13f69d\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"87f370561ceb6408\",\"/knowledge-medium/src/utils/platform.js\":\"197d48184705e007\",\"/knowledge-medium/src/utils/pluralize.js\":\"1c151b799718d92e\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"32db6b409bb62af7\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"e9213176f95dd1b6\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"5a3954706d2b306c\",\"/knowledge-medium/src/utils/react.js\":\"007b270c0bbf3f6c\",\"/knowledge-medium/src/utils/relativeDate.js\":\"4e4a25062509c5d2\",\"/knowledge-medium/src/utils/relativeTime.js\":\"887bd7b41a41c8a9\",\"/knowledge-medium/src/utils/renderScope.js\":\"f413ce90dd678858\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"73f0e24b8be28f4f\",\"/knowledge-medium/src/utils/routing.js\":\"24446da87afc4c05\",\"/knowledge-medium/src/utils/safeMode.js\":\"e781a06a6eb7f1a2\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"0bd9af546e1a04f6\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"5827276a8c3df61d\",\"/knowledge-medium/src/utils/selection.js\":\"05e0f6f3bbfc54aa\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"b3c747f8d9fdbe01\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"960611b5642d6550\",\"/knowledge-medium/src/utils/state.js\":\"7be05e6759f3044e\",\"/knowledge-medium/src/utils/string.js\":\"241af9b4e183f145\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"1cefa55158648f36\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"708b3885c1ffc879\",\"/knowledge-medium/src/utils/toast.js\":\"23192b02f99bc0fe\",\"/knowledge-medium/src/utils/toggleStore.js\":\"5c4094f90584b866\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"62321a256834d4e5\",\"/knowledge-medium/src/utils/userActivity.js\":\"764bbebdd9ad4d2b\",\"/knowledge-medium/src/utils/viewTransition.js\":\"14a407b9d52236a3\",\"/knowledge-medium/src/utils/viewport.js\":\"aa968363dd1f4e3b\",\"/knowledge-medium/src/utils/webLock.js\":\"a51238a2b372a693\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"487ecae02d6a7dd8\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"810f180905da30ef\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"6c269db2ef225618\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"53e2883c89961ba5\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"b958ea37050da4c5\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"953f6d42c3fb0c28\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"e158660221980070\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"bddf9affbdb50466\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"eaa84da5235847b2\",\"/knowledge-medium/src/vendor/react-dom.js\":\"8822d25822d397a9\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"fa4aaa6eed82d1c2\",\"/knowledge-medium/src/vendor/react.js\":\"c42100cbddfea77a\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
