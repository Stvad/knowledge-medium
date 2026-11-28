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
		buildId: "0cd3a321ab26-4c2463d9",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"3d900c8db82e1866\",\"/knowledge-medium/index.html\":\"3d900c8db82e1866\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-CsaqKFAa.js\":\"b70602323eaa5a59\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"23920d3e431ee342\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-BIvwcSmv.js\":\"09919b89408cf39f\",\"/knowledge-medium/chunks/FacadeVFS-BnqYK2z6.js\":\"80386385d9f810f2\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-B4BHwNP-.js\":\"798257b5292f5a9a\",\"/knowledge-medium/chunks/MemoryVFS-DqteDed5.js\":\"ffab5f6de73c421c\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-BqL1W_1L.js\":\"3f2d856f32d0a261\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-BVS9NyhX.js\":\"e6d79b2379e47c72\",\"/knowledge-medium/chunks/Preview-DVoxDrRU.js\":\"43d0739e7f1bf837\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-DWaQQZ-9.js\":\"79e03f8b7b458061\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BBfa2A0R.js\":\"604fdf43764cec05\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/freezeExtensionImports-CyRGRL7v.js\":\"f8f92a232564e4e1\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/lib-sLsWaEIT.js\":\"54ea87940a765649\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-6yqT96Up.js\":\"435d658d338373c6\",\"/knowledge-medium/chunks/react-972-30V_.js\":\"442dd5c3bdbe1f2e\",\"/knowledge-medium/chunks/react-DStNIiD8.js\":\"66ee842603049aa2\",\"/knowledge-medium/chunks/react-Dq6xkg_B.js\":\"65f942519c7cd317\",\"/knowledge-medium/chunks/react-DsnxM5Ua.js\":\"cf1424a72da50eb0\",\"/knowledge-medium/chunks/react-Dy7KBqa-.js\":\"554d320b08c129b1\",\"/knowledge-medium/chunks/react-NIwH2iSt.js\":\"d12405aab5803ad9\",\"/knowledge-medium/chunks/react-dM0P5NWX.js\":\"df096889ccac15e1\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-Cvi7iRt7.js\":\"4db0ad2cf9eb9300\",\"/knowledge-medium/chunks/react-dom-server.browser.production-A2aoBJ-9.js\":\"2918a0112ed02191\",\"/knowledge-medium/chunks/react-dom-server.edge.production-BXSHKpFT.js\":\"aa6dffe02f457004\",\"/knowledge-medium/chunks/server.browser-CiHSGRYY.js\":\"b1acf6ce067e5665\",\"/knowledge-medium/chunks/textarea-B49-gXRv.js\":\"6e4e27004a567ada\",\"/knowledge-medium/chunks/ui-rkje64jo.js\":\"1a46fce86e918b1c\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"961dacdb9d1c09cd\",\"/knowledge-medium/src/appUpdate.js\":\"5adbca361770afe2\",\"/knowledge-medium/src/appVersion.js\":\"6ea1653a008694fd\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"d98fd5c06db43731\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"c53d74828959f05e\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"a2797383cfc98278\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"fd95fb88b912fabc\",\"/knowledge-medium/src/components/BlockComponent.js\":\"85c85356dc988322\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"4299c5ce176ce308\",\"/knowledge-medium/src/components/BlockEditor.js\":\"000f34c6f3d6635f\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"3cd5d6175f1cfafa\",\"/knowledge-medium/src/components/BlockProperties.js\":\"57807798ccddaf29\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"08bde22048c52529\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"91543ad4ff0c4805\",\"/knowledge-medium/src/components/DividerHandle.js\":\"802708a83d706045\",\"/knowledge-medium/src/components/DraftEditor.js\":\"fb3d03fe93a95e1b\",\"/knowledge-medium/src/components/GutterPill.js\":\"0dacaa31af6799f9\",\"/knowledge-medium/src/components/Header.js\":\"3387e148963ead23\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"e672a9a740767058\",\"/knowledge-medium/src/components/Login.js\":\"38283de20556421d\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"c7204e71623454e3\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"990458f5e291850e\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"63038d38df04d474\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"63777114934cd458\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"e51892979d45d8a1\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"b1085d49f3712814\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"89a33dc533cc9bac\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"883db4a37ebdf5a1\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"eff2949bcf5671b2\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"3bfbbf3f48ca5fe0\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"776c09c4b24fb2b0\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"e0a8eacbb9fadb0b\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"d337eb1fc0591454\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"c9d57c54dc9b7efa\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"16d2d5017db306ac\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"07c4db36f1b34efe\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"83198332680ea6ca\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"ac7e1e3c8a61535c\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"076b8653f4000d49\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"c6edb240fc993b56\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"6324e10e180f90b0\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"b93b7da846fcca10\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"d94d5ec3ab77efb4\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"813152835119b0e0\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"0d84eb19be93e65e\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"40895f2a89026f88\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"d4cc17ba72ea954a\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"72626458ec177dd2\",\"/knowledge-medium/src/components/references/CompactReferenceLink.js\":\"a527bfb938d8ada3\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"4e66c3be45e2e072\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"612ca8ab947e43bd\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"90cb3df9090b3823\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"8340bbd54a9800fa\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"0ca5c52a8f31b16f\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"0a31effbf822fe2e\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"1b234ca89429bdeb\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"15a1c0591e01cd6d\",\"/knowledge-medium/src/components/renderer/BlockReadText.js\":\"840025e429de3a7c\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"d3402fbfcfb19543\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"26edb5bd95b7b65d\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"b0eb2000868b99d9\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"6e0974ca851503b8\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"043c9c00c60769ee\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"3737440b4e8c45c2\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"94305a871c168ce1\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"187543ed5db958ba\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"087022794e3b1e1f\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"1974d22c3298dfa0\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"687af16c8804f58e\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"baecd4bbff24ee00\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"0269b09ffa2b9e14\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"ed86e5e466a0528d\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"67070aa320f67117\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"bcea79be19938d34\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"68988460a44c6f2d\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"5cbd04dbf8e683fc\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"7c21822cd76a1898\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"50e326697edf826e\",\"/knowledge-medium/src/components/ui/button.js\":\"69f7148cd10dc6fe\",\"/knowledge-medium/src/components/ui/card.js\":\"3a9ac460830c6cf5\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"d9013d1f38ee2712\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"ca9089ae1e5284a7\",\"/knowledge-medium/src/components/ui/command.js\":\"5b067905e4db4385\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"b08e66c560162e2a\",\"/knowledge-medium/src/components/ui/dialog.js\":\"0f67f6c2904ee52e\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"6d41fe5ca0732169\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"aa08b7a7c1ad364f\",\"/knowledge-medium/src/components/ui/index.js\":\"91db3b6b04f41bfb\",\"/knowledge-medium/src/components/ui/input.js\":\"bfc20e6d88760d52\",\"/knowledge-medium/src/components/ui/kbd.js\":\"aa83edff622539ce\",\"/knowledge-medium/src/components/ui/label.js\":\"2798390d7ab54b46\",\"/knowledge-medium/src/components/ui/textarea.js\":\"be0cee86de26a924\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"bd1506434e70686b\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"15c7f5d00d536486\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"814b99204b487287\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"2df3f4bed128f2e4\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"196e873aa4133049\",\"/knowledge-medium/src/components/util/error.js\":\"013d225bd34bad12\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"96c414f023657278\",\"/knowledge-medium/src/components/util/suspense.js\":\"889f20612fc7ea70\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"28eeb325f7640809\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"e9d754a80a38329e\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"dd4eed690d6826c7\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"a8385dbbb9ecfdd9\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"75cb38e77cf99dba\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"c38903fff81279ce\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"41915cdf2203cc45\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"678bbcbe66ccd092\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"675882bf97512112\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"be7ea2ff93e53f8f\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"a0915410901430e6\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"3efab8c1c04511a3\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"009a18acf721941a\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"14589aefc01ba3ac\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"613edb86e150c682\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"27f29da1a6dbfb3d\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"41b072cc61979daa\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"c629343073da03f1\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"553cb4a3727f8ff4\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"91827c1799fabc97\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"5da9895b93954c64\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"e7ea6fb551373e01\",\"/knowledge-medium/src/context/block.js\":\"e4c2d1ebdfb9cb68\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"f03f3c2d4239c1b6\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"1690ddea95818288\",\"/knowledge-medium/src/context/repo.js\":\"cfeda2c786d1074c\",\"/knowledge-medium/src/data/aliasClaim.js\":\"1463016e966c1a0a\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"b32fe3b72cdf1002\",\"/knowledge-medium/src/data/api/blockData.js\":\"c31e07efea3caa76\",\"/knowledge-medium/src/data/api/blockType.js\":\"d33afe5b2768db92\",\"/knowledge-medium/src/data/api/changeScope.js\":\"7237e4482f2f46db\",\"/knowledge-medium/src/data/api/codecs.js\":\"10557c77dd1df81b\",\"/knowledge-medium/src/data/api/derivedData.js\":\"81d492c91dba0ffe\",\"/knowledge-medium/src/data/api/errors.js\":\"88eef41a09dd5382\",\"/knowledge-medium/src/data/api/events.js\":\"e7b4aeb59af1a114\",\"/knowledge-medium/src/data/api/handle.js\":\"baea2dccc4415181\",\"/knowledge-medium/src/data/api/index.js\":\"82e81e3e148e0629\",\"/knowledge-medium/src/data/api/mutator.js\":\"00780d7bb01db864\",\"/knowledge-medium/src/data/api/processor.js\":\"96d62729fb1107eb\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"73ece7d95987b7fc\",\"/knowledge-medium/src/data/api/query.js\":\"f45ea98fa46843ee\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"6568174605cadd04\",\"/knowledge-medium/src/data/api/schema.js\":\"baea2dccc4415181\",\"/knowledge-medium/src/data/api/tx.js\":\"baea2dccc4415181\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"eee3bcbc7a367772\",\"/knowledge-medium/src/data/api/user.js\":\"e903c1290058488d\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"0e32eb6e80f8a2e5\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"c1f559f3c2fe8d7b\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"569d07820b4b7a4c\",\"/knowledge-medium/src/data/block.js\":\"87fa3964a8e32755\",\"/knowledge-medium/src/data/blockCache.js\":\"da0d40c437d974a9\",\"/knowledge-medium/src/data/blockId.js\":\"1123e1c3c5900fc7\",\"/knowledge-medium/src/data/blockLiveness.js\":\"50d683bfd3c2448d\",\"/knowledge-medium/src/data/blockMerge.js\":\"c52aef0a4b27c587\",\"/knowledge-medium/src/data/blockSchema.js\":\"e6c6902c0abc98de\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"fa1ee3d762b21587\",\"/knowledge-medium/src/data/blockTypes.js\":\"89f6d09a82ae43d2\",\"/knowledge-medium/src/data/childrenView.js\":\"01788dd5ec7378b9\",\"/knowledge-medium/src/data/clientContext.js\":\"07d5dd664a696899\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"593726dc1a60e916\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"9ab7a3e263f94917\",\"/knowledge-medium/src/data/derivedIds.js\":\"f4491cbf2136c665\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"17ef8649b6be9b13\",\"/knowledge-medium/src/data/facetBridge.js\":\"6361adfe0ddc5e6f\",\"/knowledge-medium/src/data/facets.js\":\"19e14a5464e7b80b\",\"/knowledge-medium/src/data/globalState.js\":\"b0438f8440379323\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"8bcc2e2fb92e202a\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"0fa1f9945e612838\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"039332ccf2107df3\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"21933bd3dbe0ee5e\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"5d17298e2475bd8b\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"59b57e56bc274f11\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"11ade6659b8138e1\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"0cbf689e9e4647aa\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"56d064c77bba900c\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"43c36d5a363e265e\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"f6a929d24c918296\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"07639946f7f8ed08\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"fcf01a10eafff76a\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"d93c88f2ed40869b\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"cb5ad9fc82bb8db4\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"e0be557275a1e07d\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"0fbb21509c22c727\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"167d0efb997bbce9\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"7866173d06e98c56\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"ced9af1a2f4e0399\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"848d03239e2282eb\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"f8046b551c5f55ec\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"d3bd1bc14ae8b71a\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"6ca1ac3fd08571da\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"59200653287d1553\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"7263b8f544b6ec6d\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"6f443cd70d8c1dbd\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"e5067a7769852f36\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"6fc813b41b25b4ff\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"ae52e8d81a4fb7bb\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"d953dcf4964b732b\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"313b6a31c5dbf2e2\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"610370e3dbc258e4\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"274184a4c59cb0b2\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"ec207606a60f7f9a\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"00ee897d29d6afad\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"02e06aff86efdae5\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"1ef8cc501f970cd0\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"16d7fe212bd2f1c3\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"4d3d917ddffcce11\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"2e08f7e582b02cc2\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"0d67c3f7c192783d\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"d896671519f129e5\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"013f22c65e3797ee\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"a5e7ff3ef9637bae\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"497b8422a91f4024\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"1492a45f84a80ad1\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"058e8d73f03a2db9\",\"/knowledge-medium/src/data/invalidation.js\":\"f5641a63a5859c4a\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"ecdeecdd8f297a47\",\"/knowledge-medium/src/data/kernelPage.js\":\"f42d401c27e6f5dc\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"63491752d098d456\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"5b5d176e3100998b\",\"/knowledge-medium/src/data/localDbStorage.js\":\"b163706c3da6d024\",\"/knowledge-medium/src/data/localDbVfs.js\":\"19f20493a8d1800d\",\"/knowledge-medium/src/data/localSchema.js\":\"c96a0d036564e035\",\"/knowledge-medium/src/data/maintenance.js\":\"ccf4f5c76202c8da\",\"/knowledge-medium/src/data/mergeProperties.js\":\"988077a63fee9f9c\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"5b0816de62fd0c3a\",\"/knowledge-medium/src/data/migrationsPage.js\":\"3e738117f0189edc\",\"/knowledge-medium/src/data/mutators.js\":\"56dae74644357799\",\"/knowledge-medium/src/data/orderKey.js\":\"ec6ee441b46af5ed\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"e84ccd62e17db3dc\",\"/knowledge-medium/src/data/outlineSurface.js\":\"bd3b72da1552bc0d\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"2523e18d6c69cb9d\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"de3d8b2dd30fe5fb\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"d570e506df648bfb\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"83be487f75128e9a\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"a8557fc270dbc8b3\",\"/knowledge-medium/src/data/properties.js\":\"63e232cc53596a85\",\"/knowledge-medium/src/data/propertiesPage.js\":\"8b43db7081b2bd0c\",\"/knowledge-medium/src/data/propertyChildren.js\":\"9de2c1be5e6b03b4\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"3f20b3a237f6cf7e\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"0d5223cbec0d3199\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"5e2ffbaeda5cb1fc\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"aaa7273cb63c84f2\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"678b476704d5a2c8\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"ae5c2f9fac6247e7\",\"/knowledge-medium/src/data/propertySeeds.js\":\"fc0ac544ba3cfc4c\",\"/knowledge-medium/src/data/recentsPage.js\":\"b36f3b1b87570c3f\",\"/knowledge-medium/src/data/refTargetComparableProperty.js\":\"c3f307806a15b617\",\"/knowledge-medium/src/data/referenceBlock.js\":\"943625701c9daf6b\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"173a3f81e0971391\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"9be040a3c04c6286\",\"/knowledge-medium/src/data/repo.js\":\"8553add4ac5af9f3\",\"/knowledge-medium/src/data/repoProvider.js\":\"89156e0ca80b563b\",\"/knowledge-medium/src/data/rowProperty.js\":\"9b6d059a6ccdb864\",\"/knowledge-medium/src/data/searchFilter.js\":\"7d26d99b2aba1ae9\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"e025693525ee4210\",\"/knowledge-medium/src/data/stateBlocks.js\":\"1c365f5dda22d3aa\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"06d3dc879b81abbc\",\"/knowledge-medium/src/data/structuralInsert.js\":\"0acffbf95c7063af\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"176754fff3113c33\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"50a769c33abc9795\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"ee98803abe92a182\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"21f8302784e07646\",\"/knowledge-medium/src/data/targets.js\":\"f1d6809251499031\",\"/knowledge-medium/src/data/typeColors.js\":\"20cd51b389b79f84\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"8537677183b2b321\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"318fdcdcb048cfdc\",\"/knowledge-medium/src/data/typeExtraction.js\":\"291e7c4cefcdea0b\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"4bd8ba1379915f3f\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"33f7e869c71869e0\",\"/knowledge-medium/src/data/typeSeeds.js\":\"9dbd56a39ea099b9\",\"/knowledge-medium/src/data/typeTagger.js\":\"d5f3a067df210f37\",\"/knowledge-medium/src/data/typedRecords.js\":\"ccff2138753dc9cc\",\"/knowledge-medium/src/data/typesPage.js\":\"1e2e2e138b4bf75d\",\"/knowledge-medium/src/data/userPrefs.js\":\"c0ec668ae2ac4b86\",\"/knowledge-medium/src/data/userSchemasService.js\":\"992040df58e4dbd4\",\"/knowledge-medium/src/data/userTypesService.js\":\"d888dafa44423fbf\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"fd3b7642d617a6f9\",\"/knowledge-medium/src/data/visibleChildren.js\":\"faea046bd9565922\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"ad7acd97f9e70632\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"28ca6b0df867bdbe\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"0da169b11a185140\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"3f600f08a728d76e\",\"/knowledge-medium/src/data/workspaces.js\":\"1f5d5c90e9967d2b\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"2e29bbb3c9c53a75\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"3f95b1a65d50f3be\",\"/knowledge-medium/src/editor/atTrigger.js\":\"cee0ac72b3b494aa\",\"/knowledge-medium/src/editor/autocomplete.js\":\"131771a8b32eb81b\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"56a859fcf8592c41\",\"/knowledge-medium/src/editor/contentFlush.js\":\"c286113bab329166\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"b9e245745e960dd0\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"f9d1ad6f9fded376\",\"/knowledge-medium/src/editor/insertImage.js\":\"3edfbf7b3b384fbc\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"c3721b1ab64924a1\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"e420a51b86ef096b\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"e5e26eddf85bf621\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"6a3458e72c98e25d\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"78d4984dec5d11a2\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"6336abb73216aafc\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"ec607320c06c5929\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"88dbdadfa62a4b46\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"34be91a686f4f2b1\",\"/knowledge-medium/src/extensions/appRuntimeController.js\":\"43f9cf686077a000\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"3c66fdd0fede5209\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"e0061053aecb8e08\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"e25804076070ee76\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"2504d76357e07ba4\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"cb9fa856c834a861\",\"/knowledge-medium/src/extensions/buildApprovalRecord.js\":\"e74179e87352418b\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"8f9808236a0816a0\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"0f4a71623dd5ad4a\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"b0d14ecd0761535d\",\"/knowledge-medium/src/extensions/core.js\":\"c9fc23d9dc157e8f\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"3ab19e9271f2117c\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"89faf60aabe25120\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"e06c535204bb0aca\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"a3e73307503ef5ff\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"fb1b0732ce34a2d8\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"75966133c28773ee\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"db53177dcdc8169d\",\"/knowledge-medium/src/extensions/extensionImportPolicy.js\":\"2a295f1e3786833f\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"e6f6a9ead62d15a5\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"89472d35e1bd948d\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"f068901a3c499d81\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"55eb1547aa5514f5\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"cf22ce226491ee80\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"fecc4ee9d9b656d2\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"d6e66d2840a5f309\",\"/knowledge-medium/src/extensions/normalizeExtensionSource.js\":\"59dfb3e70301ff50\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"b8c36b4980dcf76c\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"81ae14e5aa0d0f99\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"8cf93bfc39114e72\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"d3d8ae76a9fc9ee2\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"a466cb91fdbbadd7\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"c6684a3e11f304a5\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"f2ecc79b78b42e1d\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"f3dc2661fcef4207\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"9b3face8863d37fc\",\"/knowledge-medium/src/extensions/transpileExtension.js\":\"ab3510220b157246\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"ce7a5cd489c56cc6\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"c07b8e4e9af41c85\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"c1939ed81d9b41ff\",\"/knowledge-medium/src/facets/facet.js\":\"40aa147b0aeb81dc\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"8a879a63b79ff6c1\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"129d9fed8efcb19e\",\"/knowledge-medium/src/facets/togglable.js\":\"aec219b385477ba2\",\"/knowledge-medium/src/facets/variantFacet.js\":\"49f69a5476205bf5\",\"/knowledge-medium/src/facets/verbFacet.js\":\"b2fdd2ee9b546201\",\"/knowledge-medium/src/hooks/block.js\":\"1d9edc5b337e0251\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"37ae54ccabdc0230\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"c63c7a0006eee477\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"a8af55d931f5f443\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"48a46b34340ebed5\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"01ea0cd04c658537\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"8537bb999d37afa9\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"35d1df11a0d3723d\",\"/knowledge-medium/src/hooks/useFacetValue.js\":\"39328df8edef0b67\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"bf8e61c9cc0119a4\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"ea06e170a01aa32a\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"5fe6116894285058\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"b8a8697933d63bff\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"d283e57f582059f0\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"ea3d61a0bb8c1a4c\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"e9d42f3f0a574545\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"982874221f6b5f8a\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"03ada8f1e88290fc\",\"/knowledge-medium/src/lib/utils.js\":\"eb34c8443a1d74da\",\"/knowledge-medium/src/main.js\":\"1b00d5551d153170\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"ebc2b7755b2a43fa\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"ab7ce743a19bbd9c\",\"/knowledge-medium/src/markdown/context.js\":\"c3dd8996ae6b0153\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"42f35da77ecb804d\",\"/knowledge-medium/src/markdown/extensions.js\":\"1088937bb71721b7\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"a7e47839a1359f2f\",\"/knowledge-medium/src/minimal-editor.js\":\"d0c09dc279afb496\",\"/knowledge-medium/src/paste/armedCut.js\":\"477e22585dfc0844\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"927e8a61313b580b\",\"/knowledge-medium/src/paste/clipboard.js\":\"15a1f9e7c1164bb7\",\"/knowledge-medium/src/paste/decision.js\":\"7058121d0883dc5b\",\"/knowledge-medium/src/paste/operations.js\":\"4d5d47f9b9b73bf2\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"c221affc13b9353e\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"2c1970b56491b5f0\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"7993bd6ae0a71ea9\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"e263e5566dcdf7ed\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"4244cd09d5218aa7\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"d8b559df50506ac9\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"e4a2a116e7509a86\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"058ef21806957492\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"e2e9f4b0d7d0350c\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"3aca5abb09f650f5\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/retryAgent.js\":\"f293a30bbf1c624d\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"eddf78bcb7f89423\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"6d83117da735feb3\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"8843ce0ccb437bc9\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"2eb0262e1abbdd2f\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"af80d881f4b5ed7f\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"ff79bcd984a512b0\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"cee448b8ab20e5c0\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"e7f3dd03a36c48e8\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"1fb78157e5b29aab\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"41801726bfa5ee0c\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"269bd7730c461e91\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"d86989fd2ee1b63d\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"d1c75dcc31bf1d12\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"500834c236df625f\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"fab0091bd1ca8a33\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"8c7fb870a7e418d6\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"02f48ef82afbaefe\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"de8e6e7511fa4fad\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"71de3df1230bae8f\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"e4ba00b3c36d801d\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"20d0f9cf3b8f71ba\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"60ab1cb5e3739b1f\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"7466540b7e3a0efc\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"cd7ffb40ed12d2e6\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"79aaeff88ed6e9d5\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"0022734318b5af02\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"e77c42f17955707d\",\"/knowledge-medium/src/plugins/agent-runtime/dayPropertyInputs.js\":\"e6b13a04c8266e1b\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"3d44bdc9243127a9\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"a839c5e9ec9d5384\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"45ef6d8f8d7fe1d0\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"38f67a591321c40b\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"d9f5bbaa25b2bc7f\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"ff9823ec6d58d13d\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"38220630821de66c\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"1450977b2c56c3df\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"d299448884cf5de2\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"ecd8c1dcaf3c0c8e\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"e3c19b6e6c71316f\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"c4e5dd9e2393c5ba\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"db60b63cea95e4ec\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"7cf5bb3b983a78fa\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"266937c4ba663af3\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"fe57bb72b27b0678\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"945732d7ed21ccca\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"f70268ff1fb2cdab\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"a7f3643bd8ec0a1f\",\"/knowledge-medium/src/plugins/alias/index.js\":\"2f59a00998da2daf\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"6927893d7daaf9d7\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"85cc6c26e3294551\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"3ac98967fd0a34cf\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"bf90929dfec2a014\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"4bd6a6e1b20c44d7\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"aa5a400329b7c1f9\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"2a30483e59766790\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"054b6ee1d3b7c8b6\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"8c7434cc3283ac2c\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"a2bd90ddaf2c4a0e\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"8605ecf2cd643d8e\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"4da9395e9bb0a61a\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"71cf61694ab8dd70\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"a029cfd850758805\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"0ba2ba9b4f3dceef\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"24a848c7ef8721c4\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"02e252772e8c0a35\",\"/knowledge-medium/src/plugins/annotations/marginAnchorLinks.js\":\"8a9607efe210519c\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"f6b6a3494a8023ed\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"908d8f5091b35204\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"eedae079ec1781e8\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"bc293c77675e9e4e\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"7b111c9ee0a2daab\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"095c9b749989165f\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"4ad24ba34b030994\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"1ab995032886cf80\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"854de99426935f64\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"f50a7044d53e1614\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"d9cecca360a28a8a\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"cbe803eca3ac1792\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"00b4b0f69fe5141b\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"c2c127e51693661d\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"f638c32f3b784bd3\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"e134df5effad63f2\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"9587b9e944f6269e\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"efb9c417d003bf67\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"9b72071742bb1a22\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"34289fb7f2c3eb64\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"c1e48fb00c859310\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"d94aad610001eb0a\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"803cc04cbf34c737\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"d281ac27c24f72f1\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"809619db8c59d992\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"eeaf0fca003c4f6a\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"970cb2823df0f926\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"1c5f440e45322d43\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"5e95c3d68f2f70e3\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"b6a41e4a32aec81c\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"b601e8c71a349a33\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"3e4562b2feedef03\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"eba5052d22c43374\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"f059ed8e55a37371\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"1dc864ffd433f142\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"6a72d93170450275\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"7b458255c7e4f50a\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"69fc8ba6d8092ff2\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"93ec30d568df8386\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"2caa4a10fb41c544\",\"/knowledge-medium/src/plugins/attachments/browserMedia.js\":\"863f032ab9d80148\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"f85b98aeb17285fe\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"73dfc7cac8eda9ba\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"3f8ff615d9ec3783\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"01bc31bdfb964c3c\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"3863f165841a0392\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"c95259bcc4bd6155\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"9c6938404c4d0abb\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"81b7e12dbccf3589\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"b8d0d23ca1be21fc\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"16f88ef8d37dd94f\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"1c8814c157fa5f98\",\"/knowledge-medium/src/plugins/attachments/mediaLanes.js\":\"77a8018324c78d18\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"0c5c45e231d6a91a\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"d282246ffed3344f\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"0f098d70741b9f94\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"17fadefd1f2ccb3e\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"1a57b4c60371d241\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"a43c2ba62fadffda\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"42d5713ea632fae2\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"0c394b9e5781e3ed\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"de83ab38f4715d8b\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"7eb9d8740e383d75\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"0502290729a4a2b2\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"3774e19ccce4bfae\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"c0318209a9dbeba1\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"5f211681ba15b449\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"59d34f0ee22728d3\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"fd3e72491823321a\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"d01b83ff4227885e\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"0943ac027bf89dc6\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"969fa90493c46c72\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"89a4295461782306\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"c41d693af50778bb\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"ddc9e710446c7fe8\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"c0a635def72bbd78\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"1ab1afb2eedf881b\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"946187ec40d8c387\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"64dcddb4b91d5162\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"5aa2041948c1ced9\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"1b626e2bd0de3e80\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"e898ba53812b84f9\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"bcbd74fcc9cea14c\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"a727dc68f7f598a4\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"5d57feb16c70d916\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"01abc8ac869cf3c0\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"7b80399a48ddc446\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"ffcc0ed9ad85dba6\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"37d12bff39f7aff4\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"11f5693c07321929\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"84191ecfbc235da0\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"60b32c2280e58488\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"bc1d99cf3667e19b\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"0c4bdc4113bdd9ef\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"7e58f4859376ead9\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"5e06115d94e295d6\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"16d7845a083441b6\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"5e7e1abf35fdc095\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"1813d96bcd527850\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"fe9dc5da6129c004\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"273422bdb35c950a\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"3b74edcae685dc39\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"7145ac489832d455\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"2be3244fb39d7195\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"cf7128e3f9b84a5f\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"576169d2fdacd976\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"949d3e406526f20d\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"a25c74602eb340eb\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"b4d41717d3d75caf\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"a2070692300d56ad\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"248e933530680be5\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"e8cebc63b2a736b6\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"ff05c4039733a908\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"70e7c3780944e0b1\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"7b14e5d73f0cc727\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"c356521b373f5836\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"5fdff8d311f320eb\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"a65c20916d49bf3b\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"936f8ca09b80ef9f\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"41a86ec4ee5dce1b\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"f1a18bdea07839db\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"ef31f8a3177ee010\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"10e0ee11171d6919\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"52a21948ec752f93\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"4455a95cce5adcd5\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"d259288d52cd96da\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"b8b770a17bc6cdfe\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"cf9188ce2f5f6f65\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"ee9aa506d9972b3a\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"b0147aba52b250a3\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"aa18d6ba095cca98\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"078a644dccce9645\",\"/knowledge-medium/src/plugins/character-counter/subtree.js\":\"1aa243981595cb4e\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"edf53bd729b05b8e\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"674ec0e6b0bf75f2\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"a96235c86a3edaf7\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"84b8faeaded93e5d\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"5dae9d29797792ef\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"28ac6a38a25fc465\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"9fa7c13510e1eefb\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"81110a10425e254a\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"661d724b033bdd85\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"f6b19952eee6c766\",\"/knowledge-medium/src/plugins/contributors/ProfilePicture.js\":\"1d4428f1ed86e43b\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"f4457a80b8112aa6\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"7d70641936c4b550\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"f16e85dbea5a6e58\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"e6e08112e47accfe\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"a97f02cb5297236d\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"268cdf90000b43b0\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"f130cb5b9c285714\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"811ec8fe850ecb6e\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"166c8966c3c82e0e\",\"/knowledge-medium/src/plugins/contributors/useCommentAuthor.js\":\"f7ee5b298fa0aa89\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"04d5389a0bfe53d0\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"332e17f2dbf1115f\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"b7e535bea89d23fd\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"97ad105f227b9b5e\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"46eacb19a371fa2e\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"a1395e7178a0db7e\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"2fb9b0a4615d496c\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"ccd9fe9400787b21\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"a4a6e7012fef9a24\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"1f2105d31fe4e8e8\",\"/knowledge-medium/src/plugins/daily-notes/DayPropertyControl.js\":\"d931942b305c2caa\",\"/knowledge-medium/src/plugins/daily-notes/DayValueReferenceControl.js\":\"0a08a31627adc3ee\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"e57c46a6edac50bb\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"6f69cf491fd64e5a\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"d22e2e91551a3c08\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"f005721220220f0b\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"9da8757c0b6d5cfc\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"0540ecf638f9623d\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"784c86e2ace17b7e\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"d25a03fb97d8002f\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"78325a9c6ac99eb5\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"b1261e89637772cb\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"7d32479893764787\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"b9011a0fd054d377\",\"/knowledge-medium/src/plugins/daily-notes/dayProperty.js\":\"9641bba2c5f4144b\",\"/knowledge-medium/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"95b124fd94c2d6d0\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"49b31af02f3e20c3\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"5d941ebbdc78eb80\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"64d71a5bca8f2f32\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"3787b2fd2277db6c\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"2ae11b1575818ee4\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"5169530b40a99d4f\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"9f3e6a5dc6b2090a\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"8fdb20521ca043c6\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"6271e365898ed2e2\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"f2b9d302b3e8d2d5\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"8cef22f4db64fddb\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"c4c715daa1202f8b\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"71bd6d71c3b32c93\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"4b83a06da137a535\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"1b18c78b1283495f\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"9664b34406896be1\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"fe03fd31cf0276ef\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"a49b2f0ee3ee1d90\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"b6879035218bcbc9\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"95d0ad5ac12ec740\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"32c1e6d6893d6a77\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"412ff17f8915f75f\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"66b8ebe7b32eb851\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"fdc2bbc3e2a8c9b8\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"64a4a8c021898ad2\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"1a7f94c23551120a\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"ef66c765ff0da826\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"9888aaaa9d11be8c\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"785b7fac520f3eca\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"a1a8942bd225450b\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"6d0483e5525c7d27\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"c0d0f87d7353308f\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"4dfcf41ae2a4d86a\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"b575e5a9757a57d2\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"9e8b5e4c774c4437\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"c05939656e20d4e5\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"9a2bed0e33c4c15d\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"86eb12c85b0e5257\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"f49dfd4aacb466f5\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"1e1f189e6f04c2d0\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"34645e7b73ec16f0\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"9e454724bce4dfc0\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"87fbb4d1d787e92b\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"60340db6b35a8d41\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"f3c56ee9b3bd4897\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"95be75b0d2d79e6d\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"7bbefaebe2c8a495\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"6ab8a6e17e4b79d9\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"465aa74f475d94c7\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"6250405ec77e5d92\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"bfa03bf1111c93af\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"b26d0c9e6f5ac558\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"bb9e42cb1e559bc3\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"7920d843941b9f55\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"707ac7677de909f2\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"edb04b071080dffa\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"f1d3503350a9148c\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"901c19956b991ddf\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"216ab3fcb880635a\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"402b7b9b6fe5e051\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"09dbabf2fdd3e7c9\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"3bb8ba77ecac94d4\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"04cd2a5a95330a42\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"c105eeb035e78f52\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"2fe41d33ed5be31a\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"504f7b4dd7799157\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"eec1ecd95d6a7aa8\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"9cb07abc925cbc31\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"61485ca322c13b30\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"18f4dc6c2bd8cb54\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"9451c1421870caaf\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"f7394d3540164de3\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"9fcbb42b3c4ec7e9\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"43d83c7f4c8e79f9\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"8f197df2f5ec6ff9\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"44753a09856c9fbf\",\"/knowledge-medium/src/plugins/geo/index.js\":\"cae7c330e4ddc177\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"707844e1ad9e77c2\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"2d068deeea951ba9\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"90a0d8214d22f8cb\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"742968054ba978f1\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"6c162333f5a34959\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"187a7b0a5ccb3476\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"4a0695e50feec2d6\",\"/knowledge-medium/src/plugins/geo/query.js\":\"5002fd2c553bde7e\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"8e8f3345e4a8c344\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"f1f96574241af41a\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"3a3a12cbbf4e4b67\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"3fd1a7aa910821af\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"5544f1c1b583ec6c\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"a92dfd9404223067\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"feec7d663b21efff\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"a0155401ff4cd6d4\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"5614af85a9292352\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"887e7f346391af99\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"b8799cf29fc4bbc4\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"690a39b536a4b7a5\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"766feaf4618ea9a4\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"33ab277afd8b8645\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"677be404dbc89f3f\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"7d19371248767fb1\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"a13ec8031c0c8d01\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"312be8d76d17cdc8\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"20608a6774f68b39\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"78a9a85f4be59d5f\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"2d73e285c701859d\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"dfc8d046caadd980\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"eaa8cb6b91e923dc\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"0e8f14598533d25b\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"ca923f5428ea6fe3\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"8cd9f2a164ed03b4\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"21e4761a222b48cd\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"fd0b6cafe88f75cc\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"7f69203c2862a502\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"69ea16078335d976\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"e41f25dedebe47f9\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"e03a4c4fd0950e56\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"bfb541a1215201e1\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"3ef8cb68adb01847\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"ca15c5b6e52945fc\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"42fe69f12c76e835\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"fb4f1300cea2ac0b\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"6b06c118f3aa4903\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"82b1ee072a47fb9c\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"db169aafdb3a0dc2\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"78220a240734eca2\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"f03756d822d3a771\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"d40ed5e8ad293121\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"e3301e45694e1f9a\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"ee7d2c5cf451ac81\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"8123fa6955da4e1c\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"29e4751d745a7551\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"2890b5fcdfc89b0a\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"ae13f703045fa100\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"45f68aed3472b4d1\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"1d2c64226f5a135a\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"4ee025af3ba2f5a1\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"34268f95d12bb81c\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"ff449a0c4578dc4a\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"e19e68512cb20726\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"230812a9563b05d6\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"243192b420f02708\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"b294247335ce854b\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"de9149b0993f576f\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"83e47ba89919d79d\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"5a009f6f5c9386a9\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"9ac4c0ee65ac2d84\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"b99c2d9b2e4e05af\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"f20c43a11bad7cfd\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"25b8b8d82ca079da\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"a3c9f3d9d89b42f2\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"447d94ac0bc7fca5\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"2bc63cc5608fc654\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"01f06e448d06279f\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"17d02040b7946404\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"f35b7d6c0d818cb8\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"ea99b62300139fd6\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"d021d8a8bf7eaa43\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"c15c49ffa2b1103a\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"1a492aca80f249d8\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"bd509cf27cf6abf3\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"9b3ac93afb2bea1c\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"3f198cb81c6ee1b0\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"bd80ce0d645bc600\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"86decb4edad51951\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"290272f8216b4824\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"0295d42732a3e965\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"9dd00c770bfd5c17\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"58537979f3cb8a04\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"7b81558afd7cbe61\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"088ec80cfd3ac815\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"4d0fa978c3248742\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"9ddaca25ccc3c73a\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"ccb781b365ef2d04\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"4fd44cd0ed7319d1\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"045e0be84ce76a3b\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"2b099c7dbe6bb842\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"3cd6215ab62370f7\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"68e52771775cf86a\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"7510274612009c2f\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"b705dc46a76e95f3\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"f9ca3c91de544122\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"b3bae7316c90a593\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"cba008bf70bb56c0\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"764de11244efb13c\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"d1ec680db7761bdc\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"d26dc3e34fa647e0\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"a9c021137ff2cce0\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"9a92fdf28db36a51\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"d96138f3b17e722c\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"52c53cb9642a4fa6\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"daff18a52fde91e2\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"fe6b8b40cc63406e\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"70303fa5d3475e6b\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"99497e362a7691f7\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"7a92d29440d03f46\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"c938dfeb9bea5f1b\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"89dab6dea0aae851\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"3dc245c4b1e557ae\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"944891a4192712ee\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"75af2b78e367118c\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"940b68211dad8041\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"e90db3144f804159\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"002b37b0af9ca740\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"bc961346335d9fca\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"574282206d19236b\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"a4f1285b0f195f23\",\"/knowledge-medium/src/plugins/recents/index.js\":\"c183a03fdd6eee69\",\"/knowledge-medium/src/plugins/recents/target.js\":\"61c2e737cd8b6d8e\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"c7c3d00a185ed277\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"27e8bc2a16cbf6b7\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"e616adca47d8adef\",\"/knowledge-medium/src/plugins/references/index.js\":\"4a46dd6ca491e8c2\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"15c86734d0c089d5\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"9d4b0422924c0f09\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"05aecea501ad3f0f\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"a9a32328d91aa827\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"43c055cc11249252\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"ed6c3c3afb6b0b2c\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"fe7495091627c90f\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"58185a07e417ded2\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"24111fe4d54057b0\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"87d3642277e4a898\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"0f15d9f43b82601f\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"06d3c518dc28641f\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"6a9cd0fce5a64c2d\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"10c3d7e2e802e28d\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"1325e61826f9f744\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"d2844fb2dfe1fe04\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"7307194b4c82fafe\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"fd2471e4c0878a89\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"efd5f2cd43a3818b\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"b7b0198ab7f5be31\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"e64e041a7b7b4b6f\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"5160dfb8c24d4f62\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"f5fcad1d2dd05780\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"a6de0ab8159adba8\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"576be1cc6e72d858\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"40db9fca88ce1e4d\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"4d727ca3475ecf2a\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"f8b56a65025bba39\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"b128af61052d220a\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"df5ef34a432164b3\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"41969255ab779512\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"39027a2279f8114f\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"42d969d0e7800b33\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"ddecc0c0b710a39a\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"534f72050ec0a1f0\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"d92b46b0f8517286\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"fdef70dbc8def7bd\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"e7fbb7f7baad1d72\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"04f88b5ae2c5fb10\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"9097e726dfa3f8c1\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"bc5540b6ac2d4b52\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"383d8e53d94b3d2a\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"f6763f8849a461c5\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"2b735b5c95052f47\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"b8c06a708a937ca8\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"dfe86a871b2160b4\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"7aaa870a3d2f5041\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"ca4263c067952fc2\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"4d265f59ba599fe0\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"3b30628450e39b28\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"ce8d0ce72a523313\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"c563a222ec1fe2dc\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"11b3e9289d8d0dee\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"7e1072838607153d\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"359de1755e4cd80d\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"cc2ca89006704bfb\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"2c18b40a2a106298\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"5f047a9b013bee29\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"f2d881bd2493a0f0\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"dca27afcd28f507b\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"680c0f499c95d48d\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"08df88a21f68fe08\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"8b53a39ce51ade08\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"ef9774756ac92f74\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"4c40fa33ccdc53fd\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"517db611dace719b\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"fa28d26a88555629\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"3907ece67b21c0f1\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"0314628761ba88c7\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"9a7bfe200c19b301\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"c53ec6fc53a4d44a\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"4ea1cc0abf310b50\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"f2ab931d0e47e99a\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"b91c40b779ac9621\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"392e308e24975317\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"eada670355e88ecf\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"5b6117df12688010\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"75ec5d8179dd163c\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"7f07f5688d2222b8\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"c6c9c79057657cc9\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"26f45dcc80483368\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"e425fde5567bbe80\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"037714661a55c00e\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"44353ed657e06c8d\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"21db9f797a27fd90\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"a93fb47da49b6b5e\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"7a1f24464777986c\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"03f07b0c303395e9\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"1d2486705dcb76f9\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"d947e31712909922\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"765b8afcf2f71784\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"fb66c967221e1187\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"3b4a7365a95089f3\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"667d5210ec6d1fc5\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"eddce5226f08c97c\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"55b60c9d18be161b\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"9202a1fb110a9797\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"058e8dd18768bcba\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"e198ff44ab41e5ce\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"d04df6d5ee78972d\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"e869210df10b2dff\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"3ff95b7f716e570e\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"d4e9c7d4ace59629\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"98f0933a63343a18\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"ec7805fc64830e06\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"89304818d07828f2\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"3d0e0441cb282037\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"d9646eac0a975aae\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"b9f13733e9a182ee\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"c11af86562e89467\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"d630f5750e500c15\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"ac4a3543381ff7a5\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"2ed498149cbd03fa\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"47acc0f555bc132b\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"4690182ecef9066c\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"0f4b259c0f69875e\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"78798ebca7dfe88f\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"5a5d24b4f3adde43\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"745726ee05e20cdf\",\"/knowledge-medium/src/plugins/tables/childrenViews.js\":\"20bf7b6d2b5b20b2\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"ce83a72a5ee82dcc\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"b687806b6d04afa8\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"f252028f1989d81e\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"bbfd7be043778d38\",\"/knowledge-medium/src/plugins/tables/index.js\":\"9fb8ce1087f470a2\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"da5b24aa6822931a\",\"/knowledge-medium/src/plugins/tables/model.js\":\"87930b464ccab07f\",\"/knowledge-medium/src/plugins/tables/query/QueryText.js\":\"e5bc6847a3d8e17c\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"c88bf3798436fde1\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"6bbe6c1f12817249\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"038aa1972aaee1df\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"9faf7a60e94a77ca\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"573f9e574169dec9\",\"/knowledge-medium/src/plugins/tables/query/registrations.js\":\"8f16b4c3bcff1c32\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"0cf866b5759cc567\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"8e9f631c4150ca1d\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"318b09860eb4d637\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"6836c4cb63b0f15e\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"54f1a74a850b53d3\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"348471e2ac1c9243\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"e7d8355f6fe12446\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"c6f66f83a4be9a2d\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"563c950549e8d83e\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"fdb4cf3f09dfabd7\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"95c84f9268d0ffd8\",\"/knowledge-medium/src/plugins/todo/index.js\":\"aab6e07d89784752\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"9876e2c60b80ebb7\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"06eb23ae20a55f84\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"203baedcbac49131\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"59f543301c59ef71\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"ba60ecfb7308573a\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"f4df48219eb444a1\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"6362331aee032203\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"d61c5f4887c6976b\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"d1bbe403a5b79107\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"e09cf451ac5b859d\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"d98bcda03d2487ba\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"7e7d8632ef6e819c\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"38b160276b4a84ab\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"5d842c0fbb356f7b\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"376d525260a62dad\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"95ee98e8b94523d6\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"95e601112e32188c\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"0c0510a58bc89fac\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"266e81db270590e7\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"1c8d73e44a8334e7\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"c5b7b5d318c00886\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"bbc7b8bc42a83170\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"9f38990176bf4274\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"78d5dc44ac2b54ad\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"d33f6327be696e15\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"f18472b7cb5b37ef\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"d8f42516fc0ac8a3\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"a64c97d790c6e7ef\",\"/knowledge-medium/src/registerServiceWorker.js\":\"0855f72d4bbb2430\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"f38311cb9dbe8b68\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"66c6b233fbb0e168\",\"/knowledge-medium/src/services/authStorage.js\":\"9f291fe7b7e91ce2\",\"/knowledge-medium/src/services/powersync.js\":\"3717af96fd5fd4b3\",\"/knowledge-medium/src/services/supabase.js\":\"24e544b7f946a7eb\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"797965f77727d071\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"69d27c89bb90d4ea\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"1d158f0f457851f8\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"10e715de9c5fbd81\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"e9d2d7a3dc21df06\",\"/knowledge-medium/src/shortcuts/actionKeyHints.js\":\"34bf0bf7841a74b4\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"f17cef971e87f26e\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"e441e2030a015712\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"e7867b4aa1665d3c\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"4b8406f391de3099\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"9756cd5d12628a7f\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"e3649f5dcfe8356a\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"f3b7e955db9c3497\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"1383cb07e0624434\",\"/knowledge-medium/src/shortcuts/formatChord.js\":\"210aa76788f6a6c4\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"def123b22bd9ec90\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"7b07ee13b92a61df\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"c6137c4beab1f26d\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"ec06d58f01849c03\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"d8f3ec73ed3bfebb\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"3b0e40d8d30ffec9\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"53c6b8be67e5398d\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"36472c19c511c805\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"d8c8582b9287eb28\",\"/knowledge-medium/src/shortcuts/types.js\":\"395d6ba2c31ca3ff\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"9d7dd042b041dc66\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"a2068ee03f062efb\",\"/knowledge-medium/src/shortcuts/utils.js\":\"1ce57789ebda8d15\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"3ead98d33560f60f\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"4d0d0e4cf5147b12\",\"/knowledge-medium/src/sync/byteTransform.js\":\"0fc1f0f0957b2b2c\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"b9ad67dbbbe70114\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"003fdfee0ed066df\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"c9fd6c985f289ff2\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"ddf071e07b56a38f\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"b724104506805bec\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"e40bdf69d34af62b\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"a0fcd94e7946c446\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"286377c41feedd78\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"2e2d32dc424c029f\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"1369b1f908c6cfa5\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"1313bd86b4829852\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"673b0b47cc847334\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"6f704357ead17958\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"0d063964104db24a\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"032ac76deddcded6\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"c9ab3a4b239bbd71\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"abae455ff5dfd69f\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"4f40fea981601abc\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"b0b16d5631ea9d53\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"495bb5ab261f7f9c\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"5cd65a3633684ff4\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"3ce67375ff192a93\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"37e37dd5c7a35927\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"7033fd2efffaf731\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"f9256bf78d5809d5\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"5f7f01e1c267ed7e\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"4e6ae3b40c8310ff\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"8160660af0d674cf\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"49c6c4de4a63aa55\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"b6804b63ca4905c0\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"4703c5fac25e0edc\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"c19c9421e2f0aa1c\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"d6e16ce53a1b6feb\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"c810750c396a8904\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"91fcbf8713abb142\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"3e7857aadc743902\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"ef4eeafc3d084931\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"07307a3b20808628\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"4185be78dc1f6e04\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"a7d21da4b477c1fe\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"d705962f8aa0ecaa\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"ed86a887fc5980ff\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"ac00737e6462489c\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"02027029e7af65ca\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"d68fc857df01baf5\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"19232788a0ac5aec\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"5e28f6fd3639678f\",\"/knowledge-medium/src/sync/transform.js\":\"9e430ff5fa50dfdb\",\"/knowledge-medium/src/themeBootDefaults.js\":\"93fe63509dce3ab0\",\"/knowledge-medium/src/types.js\":\"6efc47878bb0dd31\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"7438aaf259bd6d4f\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"71099b44916bc431\",\"/knowledge-medium/src/utils/array.js\":\"0feff9933381efec\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"4978a65b4e0e6f62\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"693a53f21ebdb97c\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"58f40fb2938ace90\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"6d242dff2bf493ab\",\"/knowledge-medium/src/utils/callbackSet.js\":\"0bafb87a807fc29c\",\"/knowledge-medium/src/utils/clientId.js\":\"44fd33286f96ca0b\",\"/knowledge-medium/src/utils/codemirror.js\":\"ccf2d30f6c4a45a4\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"f476bae6b7e78b3c\",\"/knowledge-medium/src/utils/copy.js\":\"d572bd37dec15588\",\"/knowledge-medium/src/utils/dailyPage.js\":\"14d58228d1ae3d53\",\"/knowledge-medium/src/utils/dbForensics.js\":\"db5e895bd4981c45\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"8cc9ab83e905ba63\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"3ec61a3fed65ea14\",\"/knowledge-medium/src/utils/dialogs.js\":\"d5910280fdb10d6d\",\"/knowledge-medium/src/utils/dom.js\":\"86f05e9ff7c4c5da\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"8db1506b564d047a\",\"/knowledge-medium/src/utils/drawnWalk.js\":\"9e5b002321a7bebf\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"ba353f5aa902e6dd\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"7d3fd4594eacd11e\",\"/knowledge-medium/src/utils/flipSlide.js\":\"9397ce2a60993666\",\"/knowledge-medium/src/utils/fnv1a.js\":\"ae8432c0ccf91487\",\"/knowledge-medium/src/utils/formatBytes.js\":\"3d7f5f9a27c02eac\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"3580f30edf7d4ee9\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"fc2bdcb6af1a606d\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"c362a4957118bd29\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"23f8c23e467eddca\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"648145cb721ab46c\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"3a148fbcd97c0c18\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"1011d4af1225a96d\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"1bb694e1e985ccc8\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"5373103b003517bb\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"04f4fbdab1706cee\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"dd0a7f4937cfe4cf\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"89009c362bf4216e\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"c68c1889df3fcaf1\",\"/knowledge-medium/src/utils/markdownParser.js\":\"fcef19224ecb8daf\",\"/knowledge-medium/src/utils/memoize.js\":\"5c8732131184763a\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"d49f0c66c4825b64\",\"/knowledge-medium/src/utils/nameList.js\":\"d1a5a4d819804cd6\",\"/knowledge-medium/src/utils/navigation.js\":\"e52f3a1102b9c88a\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"40f2519b68b8d806\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"92948f32cff86df0\",\"/knowledge-medium/src/utils/panelClearance.js\":\"e96b4a4a2c5be37a\",\"/knowledge-medium/src/utils/panelHistory.js\":\"fe7ff437bac23d97\",\"/knowledge-medium/src/utils/panelLanes.js\":\"86e89811350edb63\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"2b487d0b9403c423\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"ea9017ac13a78037\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"570fadb9afb08e80\",\"/knowledge-medium/src/utils/platform.js\":\"e3e5fe7cd8057199\",\"/knowledge-medium/src/utils/pluralize.js\":\"f4b66ada980b06fc\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"3d50d1ede900beab\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"3688e650b624e388\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"90ed19d5795efa15\",\"/knowledge-medium/src/utils/react.js\":\"d7abd9c86915c6a7\",\"/knowledge-medium/src/utils/relativeDate.js\":\"82d1d57fe1f607e9\",\"/knowledge-medium/src/utils/relativeTime.js\":\"73fa05eb75deb640\",\"/knowledge-medium/src/utils/renderScope.js\":\"f67991a5d84ba796\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"7a3fc0befbc4db34\",\"/knowledge-medium/src/utils/routing.js\":\"fd6e637d0ddce5f5\",\"/knowledge-medium/src/utils/safeMode.js\":\"b30cbb18627c5ec5\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"9a323d67939de182\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"541e2866e89f327a\",\"/knowledge-medium/src/utils/selection.js\":\"658e13d0c2cb233b\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"82a3d6be3729679d\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"4eb7c730e05d3bbd\",\"/knowledge-medium/src/utils/state.js\":\"bdff4e1304abf42a\",\"/knowledge-medium/src/utils/string.js\":\"de2f13e8d9704123\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"7ff83f0f20b2c4cf\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"afdeb1669af75e12\",\"/knowledge-medium/src/utils/toast.js\":\"870aa293639adb99\",\"/knowledge-medium/src/utils/toggleStore.js\":\"49d770827d1a8b65\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"789aea1767ada886\",\"/knowledge-medium/src/utils/userActivity.js\":\"1a3e0c6e520aa5f1\",\"/knowledge-medium/src/utils/viewTransition.js\":\"f9c29e7743cf56ca\",\"/knowledge-medium/src/utils/viewport.js\":\"b8a63e6859f81bd9\",\"/knowledge-medium/src/utils/webLock.js\":\"fe6461d789b36c89\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"ceebec8b91156ceb\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"8998171e9f136a41\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"f4d4afd212ff7726\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"ceb043d5c718bb96\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"0532ad13ebd1e4cb\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"c1869c1287be383b\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"be1662723244f7e4\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"dc858af348d32c5b\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"584aaf6ebf4c6bda\",\"/knowledge-medium/src/vendor/react-dom.js\":\"5e272c2018762bea\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"c17eff6fee76fa52\",\"/knowledge-medium/src/vendor/react.js\":\"725797a534acdb93\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
