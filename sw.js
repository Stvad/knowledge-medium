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
		buildId: "3fae730b96e9-e2460bba",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"1ef2e56ca79c7395\",\"/knowledge-medium/index.html\":\"1ef2e56ca79c7395\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"46aa4a91bcaa9cf6\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-CXudEp8Z.js\":\"dc16706080237045\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"a257246dc0ad1685\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-DyUM8ku9.js\":\"7e97d443317e1e21\",\"/knowledge-medium/chunks/FacadeVFS-BbvS0SD3.js\":\"9e89bb6bd22b42ba\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-D_1rng6p.js\":\"8c4a32653e995143\",\"/knowledge-medium/chunks/MemoryVFS-B-ScZSvI.js\":\"e2adc24116892124\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-B6U4SJtK.js\":\"1cc4d71cab3e7b61\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-DTCd-7k2.js\":\"e3fbf320c5820a27\",\"/knowledge-medium/chunks/Preview-DzS4725L.js\":\"57dfe329ad0dbbb8\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-DjSI338q.js\":\"4c735aa65614d942\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-C7ubQ1rX.js\":\"472b9b0b2b1039ac\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-C5sDssHx.js\":\"312e0bb7d3e8a98e\",\"/knowledge-medium/chunks/react-CIb-LJ7M.js\":\"9518cab9ea1c33a1\",\"/knowledge-medium/chunks/react-CTvTIQRZ.js\":\"5d8aa0b92c7ae00a\",\"/knowledge-medium/chunks/react-CzbRein_.js\":\"5f589b5752c7dbad\",\"/knowledge-medium/chunks/react-DOYP_sJz.js\":\"5fae4f32c9eacf9a\",\"/knowledge-medium/chunks/react-Doy_V3Yi.js\":\"c22d519e95fd1e5d\",\"/knowledge-medium/chunks/react-GLfA9mMj.js\":\"4bc0d525c368fb81\",\"/knowledge-medium/chunks/react-YJ-iVXed.js\":\"68bf00950d463e1b\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-CBX8e6-f.js\":\"60665500a11c14a9\",\"/knowledge-medium/chunks/react-dom-server.browser.production-DHtkb6OR.js\":\"2d269a48df748b92\",\"/knowledge-medium/chunks/react-dom-server.edge.production-j5DzmC3C.js\":\"da1b4b4c92aaa821\",\"/knowledge-medium/chunks/server.browser-Ba8mDxd6.js\":\"092948802e1e8030\",\"/knowledge-medium/chunks/textarea-DBe7KtJW.js\":\"26b1155ac2cccef2\",\"/knowledge-medium/chunks/ui-CljeIoMW.js\":\"08bb7bd6ea03ca26\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"9257d34efe4fda85\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"be5b65fe07820ea4\",\"/knowledge-medium/src/appUpdate.js\":\"ddf9ca1eaf76dbfc\",\"/knowledge-medium/src/appVersion.js\":\"48e7ac43b83aba18\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"ce71d9d059a358f5\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"623320122155e622\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"611ffadee4cd68b1\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"dca1df8946a57d99\",\"/knowledge-medium/src/components/BlockComponent.js\":\"e9d466053a4de148\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"ffdc25d183e574a3\",\"/knowledge-medium/src/components/BlockEditor.js\":\"a86d5b9344fc81fc\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"5beb4e028e049bf3\",\"/knowledge-medium/src/components/BlockProperties.js\":\"b94127328006fdc0\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"d267c19cda1f8763\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"c241cb93fc08823b\",\"/knowledge-medium/src/components/DividerHandle.js\":\"c27b251b468d4f0a\",\"/knowledge-medium/src/components/DraftEditor.js\":\"d5077a846fec4566\",\"/knowledge-medium/src/components/GutterPill.js\":\"6e1478114ba4896e\",\"/knowledge-medium/src/components/Header.js\":\"77042f71edd4076a\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"9c53f574b3e38ffd\",\"/knowledge-medium/src/components/Login.js\":\"4dc08678635f58e1\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"bb88598e86c08576\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"33e80aa65368444e\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"6ee69c9cfbbce5e5\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"ebba18d17dea5678\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"0a5436b049dc8439\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"3ce00f168a94f7da\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"39b7835244b180e1\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"61ec68615e4d9669\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"23d4f8fd97d6d7d2\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"28886c7f3074d501\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"30487e0cc36d4491\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"f756ee71bedd50a9\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"e0da8d1bcf4353a5\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"19680ecef747189a\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"08ac83759292d7fd\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"ba009039c1c89e33\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"9afc7aa28796daf8\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"3763205482f68087\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"a1a311e1052d8520\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"75e4e515c8a3189f\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"02a447a949c24e0e\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"1f8632a229e8c3d1\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"2cecccbd74d28db7\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"d24b461e42dec7a7\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"8d4f4a8df05064f4\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"fc503132068bd45d\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"2a0b0575cba120fb\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"8499b8f521726fcc\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"07faf655583253a5\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"cadddb9b88309554\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"35aaea83376cb733\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"0619392589c93b98\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"2c05c2b62bf37877\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"4a81ffcf7e110cbd\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"ce6eedd107ffab2c\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"e389a8427b02eb86\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"c4c64712ce8093ad\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"75e700aa4a5b4404\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"78f679a2f18e1a94\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"bbe546356ed88a65\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"77b90e22d6edca65\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"54c9b5ac59e5f76b\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"84700e1c218beb5a\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"283eca1d97b5065d\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"b40a37c948d77012\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"0168038c29caf7ff\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"77dce707577c645c\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"2e113b0a684357c8\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"114f8dd78e3514d1\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"f99eb565c3184e35\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"ef7ebf87c49098dc\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"85b8a0d2e806af29\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"9a7c6180700655d2\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"e1b032c0e806155c\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"53f93991998a0cbc\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"964c108cab22c838\",\"/knowledge-medium/src/components/ui/button.js\":\"a05f2372ea7b2bbf\",\"/knowledge-medium/src/components/ui/card.js\":\"8fae9789945dc0cd\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"d5fd5b022cf1ad06\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"9df36522c111ffc6\",\"/knowledge-medium/src/components/ui/command.js\":\"5043bb8aca05f8d6\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"777ffe011a703388\",\"/knowledge-medium/src/components/ui/dialog.js\":\"3d75a1d411a35592\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"b45cb12ce547fb02\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"410ac1bfa1434bbf\",\"/knowledge-medium/src/components/ui/index.js\":\"208bcbdea55750c3\",\"/knowledge-medium/src/components/ui/input.js\":\"1eba154b7429624e\",\"/knowledge-medium/src/components/ui/kbd.js\":\"adb110eec1f035e9\",\"/knowledge-medium/src/components/ui/label.js\":\"f2744b37bef82318\",\"/knowledge-medium/src/components/ui/textarea.js\":\"6fd049e65078f099\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"f6a75a44c3c53e0d\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"55187b69749f0a01\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"41c632ef2efe869c\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"6888cb3547a4c51c\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"09d370747da16dd7\",\"/knowledge-medium/src/components/util/error.js\":\"b424c840e7ba6cec\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"9fee9d9a543c8408\",\"/knowledge-medium/src/components/util/suspense.js\":\"762973b17e54c03f\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"9391c3e95656ef1d\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"9907c84ad0ec6893\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"ffc89c52abf96daf\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"f8da66978abf216b\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"50b3e9e319639fc9\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"c6e3b0fe9ede66bd\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"0d5bbe791a9cf719\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"479094e09d764037\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"73568348ddaaeb06\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"c00a1acd87fcf823\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"3ac44060fbf19f7b\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"fc1bc357fb9bf2ad\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"17d91d75610aa59e\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"049c2edd31540f62\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"737a504a6bf3e89e\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"7c4b80339e8dbbee\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"6f5034e6ad1b39be\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"74209738fdc372ef\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"3e9c53654074ccaa\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"2c4939ef9f5c609f\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"f576c73a787e9d02\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"fe5704af62f71ab1\",\"/knowledge-medium/src/context/block.js\":\"81212fe615603d99\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"ac4af1b08a41c4e4\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"ff79214751f7506e\",\"/knowledge-medium/src/context/repo.js\":\"10b89bd3c15e366d\",\"/knowledge-medium/src/data/aliasClaim.js\":\"a5a43a438ecb645a\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"7765fa6e1a11dd70\",\"/knowledge-medium/src/data/api/blockData.js\":\"c0dae08b71f16921\",\"/knowledge-medium/src/data/api/blockType.js\":\"ac15d26e7fc785e4\",\"/knowledge-medium/src/data/api/changeScope.js\":\"bef9d269e32f95a4\",\"/knowledge-medium/src/data/api/codecs.js\":\"c00a0fea3e200061\",\"/knowledge-medium/src/data/api/derivedData.js\":\"3e0abd4c28ff2544\",\"/knowledge-medium/src/data/api/errors.js\":\"cecb2cb8eedd556b\",\"/knowledge-medium/src/data/api/events.js\":\"88d217ad5177325c\",\"/knowledge-medium/src/data/api/handle.js\":\"e63af6aa25caea9c\",\"/knowledge-medium/src/data/api/index.js\":\"c2e9de56164a38d7\",\"/knowledge-medium/src/data/api/mutator.js\":\"b63bee51526e1c55\",\"/knowledge-medium/src/data/api/processor.js\":\"c4f2a2cf0c12f6d7\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"b0108f80e4c3b0e9\",\"/knowledge-medium/src/data/api/query.js\":\"5d6641bde2afbf78\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"407cddaa0f654f30\",\"/knowledge-medium/src/data/api/schema.js\":\"e63af6aa25caea9c\",\"/knowledge-medium/src/data/api/tx.js\":\"e63af6aa25caea9c\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"124eb1ad9d0c16e5\",\"/knowledge-medium/src/data/api/user.js\":\"5957be1942aeaf5a\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"0c5c97d318086b48\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"c78df6158ae25afb\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"a23298680088f429\",\"/knowledge-medium/src/data/block.js\":\"a397043445bc5a49\",\"/knowledge-medium/src/data/blockCache.js\":\"da08054289194873\",\"/knowledge-medium/src/data/blockId.js\":\"d8b2e49970435978\",\"/knowledge-medium/src/data/blockLiveness.js\":\"19940d439f3d75b3\",\"/knowledge-medium/src/data/blockMerge.js\":\"b27455078705b545\",\"/knowledge-medium/src/data/blockSchema.js\":\"045541647077212e\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"8f155d403ddabd4f\",\"/knowledge-medium/src/data/blockTypes.js\":\"46c20913b16ea75f\",\"/knowledge-medium/src/data/childrenView.js\":\"ef7318aa62672bc5\",\"/knowledge-medium/src/data/clientContext.js\":\"3d9a6b021782a696\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"f254db9d8780a08a\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"36e8a4360349c7ec\",\"/knowledge-medium/src/data/derivedIds.js\":\"f8fada3c571992f2\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"cdd73355fc90d4d6\",\"/knowledge-medium/src/data/facetBridge.js\":\"f25842fccb238d43\",\"/knowledge-medium/src/data/facets.js\":\"c281d448c8f6b52c\",\"/knowledge-medium/src/data/globalState.js\":\"f56caafab71770a8\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"ed86bb9251a809e2\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"cedb08a536ae5c93\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"39a9bf9dc2fadb05\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"6f17c38b0548c11d\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"be45a800ac36aab0\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"77508bf17f9e6b14\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"4bfac64219c3c05a\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"15d968c363400bf3\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"993ed0c4d69a38d5\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"d42e527471f58c02\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"90e90648d9a13209\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"f72d07c325541aca\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"fbc1f625d4e76ad9\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"64772788820d04bc\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"9735b481bfe15c34\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"f523f6068ae3781c\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"ce9acd7223a44d9a\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"0ad2eb5bb1ca2baf\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"236603adcb0ba413\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"7aca7d77fe2fe57d\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"46d60796b1438d8e\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"9018b4d5fcfd01e8\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"bdfce5882baa7ab6\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"6b2ba608f6e9e14c\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"ae4a84f1f8ee1590\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"5d4dc60ca9d5d007\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"b0b49b313b74a3a7\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"1553ff7e02989593\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"d1017750cb1fc059\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"e412c3c7effb5562\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"aa2ebf378f734c2b\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"93f71b6088a09772\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"dcc106ec96a2ede5\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"5630ea2cd6843d50\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"e11dd84f8535a8fc\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"7a732ac2479c7baa\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"803d586815c60e2a\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"62259ffa46568378\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"77412c3d24c99b2c\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"b96215691640b70d\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"ec46f68ad3eaf1c2\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"55e075c92832e408\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"9b0a6848b4e57fdb\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"3bcb1839e91cfc4a\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"607ebd129a614bd6\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"0b70c8982123139f\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"c153dcbed5db9605\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"058db9cc8b0de175\",\"/knowledge-medium/src/data/invalidation.js\":\"5bf568ca4ad4446f\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"620a7760b8aca3c6\",\"/knowledge-medium/src/data/kernelPage.js\":\"d0d6207f52107601\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"6d8dd134008d8ddf\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"7faa59b5c0d35706\",\"/knowledge-medium/src/data/localDbStorage.js\":\"f075d7687e564cad\",\"/knowledge-medium/src/data/localDbVfs.js\":\"7f5967bd953297bd\",\"/knowledge-medium/src/data/localSchema.js\":\"80d83ae3b7b07651\",\"/knowledge-medium/src/data/maintenance.js\":\"c6aaf3822449a45e\",\"/knowledge-medium/src/data/mergeProperties.js\":\"adb09b5f00ab9c8d\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"f32acfb9f20bd3ac\",\"/knowledge-medium/src/data/migrationsPage.js\":\"6e1e7cdf149c4af9\",\"/knowledge-medium/src/data/mutators.js\":\"e118d6f496fbe038\",\"/knowledge-medium/src/data/orderKey.js\":\"d59e741fe00a4f43\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"a8f298465ab3ebd9\",\"/knowledge-medium/src/data/outlineSurface.js\":\"8c32c6db994b3b31\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"f5b83d8bb59e50ad\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"1717f3e402e5878f\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"c887c766c3672631\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"569638e008103da4\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"512c03a4c636d7f3\",\"/knowledge-medium/src/data/properties.js\":\"5fdf261ceeee535e\",\"/knowledge-medium/src/data/propertiesPage.js\":\"c1b58ea9933a5e56\",\"/knowledge-medium/src/data/propertyChildren.js\":\"0495cfa633e857f9\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"8909787bb83cb502\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"05764ca83ee850bc\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"aa453ecb9c4fee3e\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"b7b740844a7f2bca\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"3957ea7e176e84c2\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"f37da45e752fb940\",\"/knowledge-medium/src/data/propertySeeds.js\":\"259876b10443e169\",\"/knowledge-medium/src/data/recentsPage.js\":\"554f68ca48dc477d\",\"/knowledge-medium/src/data/referenceBlock.js\":\"7b330607a9f7b427\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"db9e85c846585ef7\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"8166b7714f5319fd\",\"/knowledge-medium/src/data/repo.js\":\"196f243dc06fe68d\",\"/knowledge-medium/src/data/repoProvider.js\":\"87868d42b7385ed9\",\"/knowledge-medium/src/data/rowProperty.js\":\"03183804b3b87f03\",\"/knowledge-medium/src/data/searchFilter.js\":\"891ffdd83314a0a8\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"b745cf998161051d\",\"/knowledge-medium/src/data/stateBlocks.js\":\"53dec6052f6bd9f5\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"386ad7f829b9156f\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"c4e5de1932a92c4b\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"3f206d11ed311f0f\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"d72ca3b8d633e0d0\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"cca1abc4392e99cd\",\"/knowledge-medium/src/data/targets.js\":\"38180d251cbb554b\",\"/knowledge-medium/src/data/typeColors.js\":\"151eb36a6873ca16\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"f337a066a726df65\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"f250c1bf3d7f5ddd\",\"/knowledge-medium/src/data/typeExtraction.js\":\"f14f59b4e3b3f1d4\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"12f149303889ac06\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"aed46838e53a391d\",\"/knowledge-medium/src/data/typeSeeds.js\":\"be25a7028f4c3286\",\"/knowledge-medium/src/data/typeTagger.js\":\"3d89899e7443598b\",\"/knowledge-medium/src/data/typedRecords.js\":\"a894f642413290f1\",\"/knowledge-medium/src/data/typesPage.js\":\"23bce65d52292171\",\"/knowledge-medium/src/data/userPrefs.js\":\"5c27a4552764fa74\",\"/knowledge-medium/src/data/userSchemasService.js\":\"226136c1ea996425\",\"/knowledge-medium/src/data/userTypesService.js\":\"dee3ede9b9010519\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"c5bab0e85550ad2b\",\"/knowledge-medium/src/data/visibleChildren.js\":\"132e630ecac71a35\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"4514288307171817\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"9c963588939bd84c\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"57817efe8b8a82b9\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"39c847a7bce0a88c\",\"/knowledge-medium/src/data/workspaces.js\":\"66629dd960e86a62\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"7dd5bc01e9bf3050\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"6492a8f30708f032\",\"/knowledge-medium/src/editor/atTrigger.js\":\"f900865c5b337c1b\",\"/knowledge-medium/src/editor/autocomplete.js\":\"ea97dd8474aeb30f\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"e4eaec9c49455447\",\"/knowledge-medium/src/editor/contentFlush.js\":\"298cc45600c14131\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"ea2990836d31bf68\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"9df1b64d452c70d1\",\"/knowledge-medium/src/editor/insertImage.js\":\"22ca66ef4be27336\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"d66756077a8832d1\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"2ba9a26f84039474\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"7fdcf1a48a419881\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"c7c2aa346cef25a9\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"226d27f37e3f02ed\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"40e0d98047b45ccf\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"478e0fd8cd5dd994\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"d1123d4ffac20c7a\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"1a7035149e20464f\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"aa9e0e27fb2ebd47\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"337d1744e9afc7a8\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"bab5eaf353181ad4\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"28052d909e8e274f\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"7d4c08d5ddd2e378\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"28bcfda587138045\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"b5f32ccbd03fe161\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"2ef7669d760a3359\",\"/knowledge-medium/src/extensions/core.js\":\"f1cee10e2b389f46\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"8cc279e3f725958d\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"80cb9b5ae37fea95\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"08a895b843c15d7c\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"0276437bfaf1ee0d\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"725dfa2c8fb97890\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"8a581ad57c6f3028\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"d57de301399e8e6f\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"43eceea8916fabde\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"169b888229e1a636\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"66d0c614708d75a8\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"739a521abc8c5666\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"a6e5b022fdd3b5e2\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"7871799376c5ee4e\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"e36f3bcf4b212e48\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"93cc3168805502ea\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"afc619b7ed6e8b3b\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"e9284402b5e09ec3\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"0952990e0961d09b\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"beb95aa183161ce8\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"6d40350fcf0a4700\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"731ffbbdf5c7b3b2\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"6c7c54ff4e0d9640\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"f70f0646c32c0944\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"a0c836ff14bf5ebb\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"dcbc84d52e7efc3a\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"cc97147d3e7642d2\",\"/knowledge-medium/src/facets/facet.js\":\"b37fb0349fbf4d25\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"ea9e8f51d6875a90\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"cd53595ad351c852\",\"/knowledge-medium/src/facets/togglable.js\":\"1c18c07144221702\",\"/knowledge-medium/src/facets/variantFacet.js\":\"d78374824c7b077d\",\"/knowledge-medium/src/facets/verbFacet.js\":\"8a66a06bbb1001be\",\"/knowledge-medium/src/hooks/block.js\":\"b4e3dc844e6e5ecb\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"5fa5fb8b785ce17e\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"aa084d0f82276628\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"a2f15f7299f96a74\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"26a107a07fa93235\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"1404fd7812538d70\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"95018b4f657894dc\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"140948b88edbdde7\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"909dd8378b0d0027\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"48b268ca3b37dfb8\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"8914c80538278f34\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"9012ccacd7066099\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"093a6ba6c78780b6\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"5f9888cbf9c014ce\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"daf590d4af9a822b\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"3aa1b61ea1ab4192\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"64414d98c84b5ff0\",\"/knowledge-medium/src/lib/utils.js\":\"3d9274cde0c132fc\",\"/knowledge-medium/src/main.js\":\"16e990e142f9638d\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"262d51e9ffd6960a\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"244f52ba73f4d374\",\"/knowledge-medium/src/markdown/context.js\":\"e3e42e18ac7f82f2\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"f38a3c60e53ec87a\",\"/knowledge-medium/src/markdown/extensions.js\":\"c57d234cabd3889d\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"f758db5aee1d7049\",\"/knowledge-medium/src/minimal-editor.js\":\"87981e9a06956fe4\",\"/knowledge-medium/src/paste/armedCut.js\":\"26f926724ccc69c1\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"58204fda8bee61f8\",\"/knowledge-medium/src/paste/clipboard.js\":\"a03a31e86159027f\",\"/knowledge-medium/src/paste/decision.js\":\"091a739759f6cc4c\",\"/knowledge-medium/src/paste/operations.js\":\"d48bde0602e7e421\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"804b6fd45f332d85\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"8f1abd1b7762bd2d\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"37dcd9f3a55e2f7c\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"ae439fdbc3a83401\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"f44bc4e2448e4799\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"191a13e7cf66aa0b\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"eab41d19fc162761\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"be8e1142d6af0ad3\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"f63f670b207de029\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"479e3d2de5ecfa37\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"4228a4af4a4819f2\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"24c3b440fe35a680\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"ae8e9cb347456005\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"37fbd6467404565c\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"0231c0ba1d37d39a\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"e45ef91c3724d0ef\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"698b63eafcf754d7\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"db5008b684a13461\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"22f0a9b90a1724b3\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"1c14af73e54fec80\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"6b3312efd414c5cd\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"d0fe0ee32b811360\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"b6edf03a508e4e95\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"bcb57a2007236159\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"84f50c9eace08688\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"242ae1a5c5ba41db\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"a407c5159366e7aa\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"a5b7c04ebcbf9960\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"3b353b40b2064b9f\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"7a216cb9b4a3040f\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"afe57a8a078068e2\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"434f3886d7001773\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"d286d6b20c1bd6cf\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"88af437e8163771b\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"7d2bf5ffabe4883c\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"f5ff46442550f932\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"ba4a70aef8ad6772\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"035ef1ceda705841\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"0b64cdcd8f0f3c0e\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"e38ab87556c3e772\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"150c7c2194941ecc\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"9b6c5beb298afbde\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"d208f37f4dbeff2c\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"8490a5e90b1423cf\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"08d734a031099e35\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"41ce41692c3b4b0b\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"01f9d3f98f17f54f\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"85d4a41e68c8a43e\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"ecf624121d5a7aee\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"42aeab4669b330f1\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"0751f36cf8c0e191\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"9a8fe7544f4b31e7\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"2c7e572c276ac1d5\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"c9cef21df8ae18bb\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"05032c56bb16239f\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"ac6b427e7564b74b\",\"/knowledge-medium/src/plugins/alias/index.js\":\"b1e0d376440e22ba\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"9f281a22142a3042\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"28bc32ae1850b186\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"9136cf3e21964867\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"cd302ca9cd0c9b42\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"479d2686999688f9\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"50f1f0b7078558df\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"ef191023639513b8\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"20ee0c330435f8eb\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"b2317d82a0836a89\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"c68abba166417627\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"6c7d563b66b30663\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"a50bc413363ac472\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"52d2b288552dbb4f\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"4fd27119d52664bc\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"0f13b9edade90ace\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"7dca1b620b6e7c22\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"2ae5287adeca34ab\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"aa4a9a706c936065\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"76624729bb39da3b\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"d9b93f992632ab5e\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"a9186cf119972e71\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"8764e671f72d457a\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"6893f0228c8b1c68\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"6822400c7fd982a8\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"0bbcb5cbbc0764e8\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"ad941dae8c527cc4\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"f1fae997c874a751\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"6d68b8aae85992b8\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"ba2ec7290daeec7c\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"4fb2f15ac904a592\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"9ebf74505d29c1b4\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"43fbf49392ae5b71\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"549516af9d8cca0c\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"057d6ae52468a8fd\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"490be05d0557f1f5\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"949f0a8ead469f80\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"4e0fe556bf4c4f06\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"f4881389375d9258\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"17f290abd22dc0a1\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"f6f72db77bde15c1\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"1b9182ff760ee8bc\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"4dca1b4bf5981d9c\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"31cd62feed1c8d2c\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"5582621cae1edd26\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"dee86053807b64bd\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"3800d81efa457777\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"1a61073ec38ae99a\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"bc2176124af8334c\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"6f816d9bec8837f4\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"af563a7ed49f14b5\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"8496529a078c4079\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"00ef41ba3eda3e46\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"22812530eb8d23a1\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"9f9222b219d60452\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"99ed35c98ba303f6\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"db12371efda0c956\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"54d3d7b8cd715325\",\"/knowledge-medium/src/plugins/attachments/browserMedia.js\":\"da0919c506aa8451\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"25362ba5109f5ed5\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"1818c979be01c69e\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"fa6b67fd4564bf93\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"6b2c096de9ec5557\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"ec619e5ca5c3c2e4\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"53894f6052a8dac9\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"0d6f3363c31a93a3\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"b4e6306f33cf1ccb\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"a950dcb64d06651b\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"0add73526faa422a\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"691f597d8db3b306\",\"/knowledge-medium/src/plugins/attachments/mediaLanes.js\":\"d362962de8afaedb\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"28a0b32f0d20dec0\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"aa13a9b6fc6e7a8f\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"a3cd664910b65ea3\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"f1afb2baa1f22732\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"c2bd78bfe3e2d292\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"d5a808324e2de070\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"23596590b88162f3\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"868b20da9a01783a\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"8efc3f03a1d5fdfa\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"2865153d5a948c99\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"ec1464251eb853d9\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"30a357a5e44cbe82\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"24850f07c183527d\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"d2ac727595167981\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"f673ec0048c7e94a\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"1f8c767eb0ae0137\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"894fb2b511e9292b\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"8cd2ae18bf15d708\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"1a3ccda1c315245b\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"1de460971c0da880\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"c70466f65d01b004\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"1f10eae1c4b071a1\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"d945562ab2bef37b\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"3c8c2857752f38d3\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"f124ade4b14041b9\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"a101674e113b88a7\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"cb855ef8f014de6e\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"67cce3b2c04168ce\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"252297b6a926fdd3\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"7e6e6eb7f6af1b8d\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"4df95ee4aab22c18\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"f02a2db3474d6dd8\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"5a22fec7a01649d6\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"cbbbb21716ca9c7f\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"041e1538dd3a9e61\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"6c088d099e490d91\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"ca2b64048c36edde\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"dc6e0e8e59e1c4c8\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"c074454b21c05493\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"6fb4be4d176e3c75\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"e07f7c8cd42788b5\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"0ceff332e15f15a1\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"b2b2b23ddf46fc1b\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"a6de0b26a60d7a91\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"15d7da7ee7972875\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"8721839e61b0463c\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"87a6c012c441b8fd\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"1d1231e8796c6f8e\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"e2b99b369f16075f\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"cb659d392d65697b\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"857529e0b1f48dae\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"a6797df643aaca2d\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"30597c9ec3f40ea5\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"2a90777972e4fca6\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"7d914cd4f8b3a4d9\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"4e0d5106165e2514\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"cc47a6a036fe356a\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"b5ad0dcf5a721948\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"18cdf0d6f8c001db\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"1602d10c5c0bc2db\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"4359c6de1beae2c6\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"725f97a52164d0a8\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"2182a3f5d30d6cc8\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"e79aac6cdad0929c\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"4a5acf5b8d28ee6a\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"ce7c2ec970e4030e\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"202057865903aa40\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"b648442ecac74dcd\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"ee2c1d50bd7e1684\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"e8d66032ecfe2b44\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"29c1c7f5810194c2\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"08f7008215fffee1\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"f0346aa0108e3489\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"1aebd91930e68fb8\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"2adfd448a11bfde9\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"9ac4b5a8dcccc903\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"6c718a7204482f3e\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"b4d5be04423d3050\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"78a55e18b80f54ab\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"51d7ee0997f25286\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"e8ffe4e14a31e821\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"f6b2706fa40f17e7\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"5eb4d63e8475ac4a\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"a8122f37b8fed6bc\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"9facb49dc8064075\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"3bb48386cb9c83f2\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"e465d25d5b8e51e8\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"509584ec376f9f68\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"cd59f6c6a784d8b4\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"78682bbc53322d60\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"5525c027f987500f\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"79e7f15f1a1cb789\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"ad00499e8b6c9fd2\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"4121f816ed9165fc\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"a8351aaad0022fff\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"8e7a9ce62cea1232\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"90e073dac3f4e6b6\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"d9b8a15b08bf84dc\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"9d297995001c6c69\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"8a61f4334a8f27ad\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"0611b773ffba2aa0\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"88ba10a4bd21463c\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"574cbed238fceb5e\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"75fbbc18449b3b1a\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"253977ad35b86cdd\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"4b8c008642f7d5cd\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"d6a70251dea50eab\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"b05a239653cff009\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"8c4c3ee3cc36ee27\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"f232010a556d4269\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"470532081a984db0\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"bfe95fbd96af6cbf\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"1fc9c3008c00dec3\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"f429e61bcfa2c3a3\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"986b24d6a95025f2\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"4c56bff45fe7a502\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"5e47ddf9ebf75edf\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"d3ea24e21db89644\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"82ed9d2945f55e37\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"ab39e91c67a6814c\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"fd9f129c4c9c85a3\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"76c059e963dd0cb5\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"9821134efc5aeb44\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"8fb7bb5c33c55f58\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"47c5eb27282c5329\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"c3072bd49117bdb0\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"cb318cb841abb5f6\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"2b3ce2a7121188ea\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"43c5c494f6ffdc95\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"205d03c2e4a3047f\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"69ebaabeebb96545\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"09149173cdc3a9e5\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"2f92d7826d03d1b2\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"e2ac8a6f1da26643\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"25bbedc05b6122a2\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"3477d23f2e0bcd7c\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"bbbb59da2463debe\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"0bb6df5a78b31ccb\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"8f03e2312979df40\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"16ffa71aa03b3893\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"12124c4c876295b6\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"be9c325e11d3b338\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"b87a6792ec7a57c4\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"081f60714bc6116e\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"9383c810318486fd\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"fc56c46cc02c3649\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"29ebf856884c3563\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"d288cc75440597a0\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"523b7c3a902cb58a\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"7a43482ae5e6e3a5\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"cd2e41438fc8b121\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"0cf1cf14385268d7\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"aa428bce8b38301c\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"f3879b4a0db3a76d\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"5ec8255cef13f77e\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"c4ce25bc9b1681c5\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"ebcb9d06ab813a7a\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"d25191269a500cb9\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"8fb95b446b84deda\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"b1a0fe47e5e0ba2f\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"07f6412d3860e269\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"bbe2396af3b750a8\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"73033fd4c126cbd4\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"d7af73e72f0007ac\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"67ab133b292ae791\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"2cd639a3e2d24e8b\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"fab947892d0c9e30\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"9105585468cb9355\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"69e066a5cc315a22\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"7abc6d06d3ce3c38\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"a877286fe70a16fa\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"30ddc30c17835b7f\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"24c66f311c7a8981\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"a9e65eef70add8d2\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"787cb5b08b6027b0\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"db4b1625b4a31c3f\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"c806f13bc3f964d3\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"fc9ac5373a3868a7\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"eb54e7ef1502f91c\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"edb3e7860dc5930a\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"c023e688aaefc87d\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"32645c455e97ed67\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"ad04bdb16a0b2e50\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"21a434a4282a5992\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"82f9c71d422340f7\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"4fe6a01a5b106378\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"77a853e0942a8277\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"61f450e59e904fcb\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"f98dd0b8634a321b\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"3ac36ba106f786e7\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"2a1a862256a3a8b1\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"d7dc76feadfcdf3d\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"59e78f50fd158a58\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"8101f89d5bc8dfda\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"c6e105ce645b29cd\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"7c065efdeefa60f8\",\"/knowledge-medium/src/plugins/geo/index.js\":\"6b3d7a57cad9c6e4\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"454350a47d6f4c59\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"3a0b8dc7b7d8a7a7\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"232061840e15b53f\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"d290a1974e874871\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"c401e8943e941395\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"077682973f2e1fe1\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"98e6966baf98ce66\",\"/knowledge-medium/src/plugins/geo/query.js\":\"f69633a2578e625a\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"fae1ca89ece74e0a\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"82e94c6787b6bbc5\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"0b61fa493b5738ce\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"9b5c5ad0ff6c4c89\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"ad1b1b3650d7d715\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"d0bdee3902100317\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"efc6166d51300b19\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"d5893d210dcd2676\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"b03f410ddb9a3045\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"d7cf815f31b47760\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"5df3f4fb13dc9320\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"e0492d35613c0265\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"5d22efa6b8d606e3\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"d084cf8694242315\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"78cf0c643fccd40c\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"547aa13ca0a7f296\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"aff3b1095ab3bba1\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"53f4d07f45dd123c\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"5e3b5fba3ca71eb6\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"c6653c4e079c0845\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"3695020212821c03\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"5e426085f80ad19f\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"ad3849311e4a6b95\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"0622cf6275317be4\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"35802e95cf9f3e74\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"d6926081f5267d66\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"fed78beea9f58b42\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"d7bff9882f270548\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"f0490dd4d32463b2\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"3badefe70526af25\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"80a7ff5aa7b2768e\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"fcbcd1631241cbfc\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"0568cf753c80c3b8\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"1cb39ddf207a1f6e\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"2af787b0a6d13fb8\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"a509f721dfae0464\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"43a58fcde6b85ddc\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"15cc142cc100ccf3\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"f115e2851639313a\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"59f6ad2f5f5acfd8\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"d24caf54fcdc374a\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"5a4f85603b47f861\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"d6f4a2ceea023756\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"2dd04a3d641d7931\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"fa8ff3bbe45b5565\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"1fc88c4afbc00fd1\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"fee755edbd0083d6\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"c8a1162252f8ab4d\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"f46f13b402cd64e2\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"bef1a6a45c2ccdc9\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"c4ed30ef2c7a12e1\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"5dcf84314f4d2c2a\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"6798dd0043139bf9\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"cef41099101886d8\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"3a47b2bb36a6aac2\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"97e947e5a2d5adeb\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"9c3886a01ea1cfb5\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"26ae39577e4f4e27\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"d514dc5fa89964e1\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"d8cfe6fb0837b4b9\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"8782cdbb03c8e3fd\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"62669a8b25b66d02\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"ad5ce9505130af95\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"24c1f1d9d2cb118e\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"c1d73e64fcc1677c\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"ecfa6f0078f69488\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"f3724f09978f36fa\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"75e71355cc0a01fb\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"8d45de942c4d060e\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"2bdc0af41e0101c1\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"3f0991602ca1bcc1\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"57d9a7244d855189\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"92b8adfe812603d3\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"2304da29ee7a551f\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"873c50ce76bf15cf\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"e52a2b57b262d9ae\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"a3e750cae7991b8b\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"726591e27a26feb4\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"18958aca2523167b\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"976d6ad37e57ca2d\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"2c7d616f328c5ee3\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"b74391f2064d3a27\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"6b038f16c7ef2e42\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"ff8289f315824f75\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"0662db4f73acd9f3\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"d84eb82b61b84e77\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"f26cc0dad62fbbe5\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"80af292cd26957f0\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"ca422445f85b2a5b\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"0554fc98506bf234\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"817cdecafe1d66b7\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"de69e24e005bb2a6\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"535027877979541c\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"f67b05ebdf83c4d9\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"9c3a1cbf4cb251d4\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"b5decdac1a53c6ec\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"080287261fe49057\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"02ca8f3321ffdabd\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"38c03c64bad607ba\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"2754ef0e3b177efc\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"e89b8fcdd2294b03\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"52aafb5af00d9eef\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"e425c30de8d3d481\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"4b2a1101f1249b7a\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"52ed6ea8dbaba34a\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"4cae4518ef0bb4d3\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"92b75d53db2bef00\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"4144538b73885b29\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"301c17cbb0efc106\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"e2772719f6d590d3\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"72641e9046b73fec\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"d474789262136a66\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"634acded2cea4350\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"bf6ab2433d558d65\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"61b2f6c2e34bd50d\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"a81c544e1d8958be\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"663e159053eb9378\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"be6e46cfbce4a225\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"4b2172f90af8fde6\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"d6e083be6123328d\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"247cde4f167fdd60\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"6b64ae210b64a45b\",\"/knowledge-medium/src/plugins/recents/index.js\":\"38cf842935c49d3b\",\"/knowledge-medium/src/plugins/recents/target.js\":\"5a4546eef7bf6529\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"398b6efe8e9c38e6\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"28d1712ec403e776\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"afab35522655e10c\",\"/knowledge-medium/src/plugins/references/index.js\":\"49fb2ba28021f140\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"001d6c9bd2fd7260\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"70852b52ad886dec\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"ca49c2279ccc367e\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"70e8dd683c00adf2\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"20e9712ee95e2b0a\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"4097c0e0962161c5\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"b214d80f25339007\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"2f1cc7ee38de23ec\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"cba8d517469aabdd\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"c7577da09110f4e3\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"b894ef2f4c6c2806\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"dffd665752abcf09\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"ebf22f4e7d4b2abf\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"87849aad8fb13ec3\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"080be453f3e36eb3\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"24dfcfb7e400c802\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"bbc7891375dffb28\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"c0ded8c91b44b331\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"997e7725a5ebc1dd\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"9f9510c8052abce2\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"cfdae9cbb7ade85c\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"36e542794dfefc5b\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"c696eaa803a96f94\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"3a8ee0f38fbe7634\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"4d88a3e078b211e2\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"51daaecac0d45341\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"2a5d334c4fd3ada8\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"e1b41e1d2bd8bd1a\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"2d99d91dabc2e81c\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"9afe92eee1383963\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"9e9e2a61fdbd1198\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"4560b61e9b722e15\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"0affd6b00b649fda\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"d296e513120a4658\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"13093be683ae5d66\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"9d47f52e4ed06cc6\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"54dce404521b0440\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"64cad861daff7795\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"2c60ac42dff553a1\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"e858cd011a0d26c0\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"147ca5ff669c9285\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"81d265d6c8d66ce7\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"b40dbfa70f2245b5\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"6ee16efc8cc06b15\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"d412863f2052b807\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"2bd19b8ded6e2119\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"32fcccbe29abe24c\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"4bc92c15b751f46b\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"c91c7453466e91b4\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"d3247e63faf906f4\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"a86a1cd8118e2fa8\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"0a7094bc0256ca1d\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"5af2842e6ae0e9c5\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"7deab827ab1c0aad\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"bfa778766cf981df\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"a34a60d58d85665a\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"340ab825ac77092c\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"06d87ae804070c00\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"ce36cdf15cf4017e\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"85b53d3b29c18752\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"c79639d8251b3e26\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"dd3f2f54b9afde8a\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"6e69e8d09d4ccf35\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"76c8699ccd2bb442\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"8c9ec0b1c24b24c3\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"4e715968f6f4e004\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"ac65ad3ee7b8d2bc\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"a6bd53a35fe924c3\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"bd5c07843310c85e\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"ed1297b2f022886b\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"24d230ef0148b9dc\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"1a2f60e1526e3896\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"38853f02a53a4a1c\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"6a704a707ab7802c\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"99c59e729e57c5e4\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"163b3093213dcc7d\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"3f01ca3453656770\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"1e44c8501feab984\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"0505fe113dbf46f4\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"65a5c83edea61371\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"52683ac418070d27\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"f7d1d66fefcef2cd\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"200354025060a487\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"d8e120f9cc1f7ffe\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"bd6fcd9b10d07d8e\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"ce2196f2b039be10\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"0b7f003bac67f5a4\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"27e985f3dafa07d1\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"b1b5a02cd236d669\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"42e5b0e47d83b8cd\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"69fdba2e3a52b8b7\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"601d21d21fcc854a\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"ebdc91caba3e0fed\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"6c3e864e582e4f5f\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"ca393bac15aed033\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"f46ea34495f6d4ae\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"69c042392a321764\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"c4cb39eb6619f209\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"f44e446c013b0f67\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"a7ea00cc887be486\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"f248191818d8eebc\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"f6c945cb4fa3345f\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"b2aeac40b0b351b5\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"d0af0c6b129fbaca\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"6f1757b9e57bca4e\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"129992927f1ba6cb\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"c5d4688c8f4120e7\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"20b7dbd41a7b96b5\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"a1132bd0506b21c1\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"eab0cad25350d3b9\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"80fe91436817d7ef\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"d3575685069bb437\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"17107e635fdecda0\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"b2b7b7db4dd96f23\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"c889659614947e09\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"26cfdb42aafdb228\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"1ba00fd88ac8aa17\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"7afef6c38ad59fbf\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"4ac072bb444de34d\",\"/knowledge-medium/src/plugins/tables/childrenViews.js\":\"bbfdb35c054cf8f9\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"facbd01005fdb4a0\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"40c3438360b409e0\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"04959cd7ae0cd2ef\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"08dd68914909d83e\",\"/knowledge-medium/src/plugins/tables/index.js\":\"89ddb542066277ff\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"d9a68a4b08e3458c\",\"/knowledge-medium/src/plugins/tables/model.js\":\"18f52e2ac950498f\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"ce8fb491a5fb3ed4\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"e9812a45c3deb2bc\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"b6592394ba489393\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"19b5252548a4f916\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"e0ebd84debd48614\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"2c7b6a1fdb937155\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"ca0eaa1bbf8cd8d4\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"c52f53bc57c08b13\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"117cac51f439dbd1\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"1562a164a8363d19\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"1fcad906a8214d4e\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"84d281e839dc243d\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"d7155992ca40bfdd\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"e730786f451e7c63\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"f8b391ac7b72e491\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"5fae13df3c461069\",\"/knowledge-medium/src/plugins/todo/index.js\":\"b2c466ddeca3155f\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"353f80946210e3a0\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"26e721a5229cbd9e\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"4be3d6fdea434e4e\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"59990c41dff74d65\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"52893d21b22b9e32\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"aecfe11696619dbb\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"e852c16d0b33e268\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"6f0859fc9aab52bf\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"425db7a3c1a94ae5\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"04ce4d21b339a5d6\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"38dd993f618e257e\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"0b3fb82dbcad4b49\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"bcf8a10fc677e9f6\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"a0330804dee909ea\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"e17280d695c27889\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"6a64b35cb5c37845\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"245262e78e3f478a\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"21d36a8a43eb9e85\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"9612f8ea549f48d8\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"d8f12852f0e130d0\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"b5668b00f0e8a9eb\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"401aa4d2deef6e9b\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"354525ddc9a6636a\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"b2563dc87a199c30\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"4b4c0c5eb8c74dd6\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"d836f8dca96c83bf\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"81693d783de46495\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"942dc781552d52c4\",\"/knowledge-medium/src/registerServiceWorker.js\":\"dc94d4f2f2385fcb\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"363e7f746c5945ee\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"74896d7e0a84195d\",\"/knowledge-medium/src/services/authStorage.js\":\"f388b8940263387e\",\"/knowledge-medium/src/services/powersync.js\":\"257379e6fa24632e\",\"/knowledge-medium/src/services/supabase.js\":\"f11b0b76921d67ca\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"98eab3e3702cca8e\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"33d89dab821fc135\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"724d5c108bd7d4cb\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"c57e9556440bb976\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"922f3ef04c01d16d\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"b8c8142f1ade39d7\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"2cfd49aef23e2cd5\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"ea37060332036052\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"136552a53e447962\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"35e88aed4577d28d\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"3ca53db8bfeab9c5\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"ceae828dc9dd825a\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"445d6bf160c26222\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"e0cdb7c5df34b8ff\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"e687418d57a3296c\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"e2309d89f7915929\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"bcce5ead0d329dd1\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"d3da96d4f5226f5e\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"361800a25d00000d\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"96600e169586ce1f\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"b3add167da3b9052\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"aa65c31269a27acf\",\"/knowledge-medium/src/shortcuts/types.js\":\"0ff3cfa8e7ee14d3\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"78927bbf6246c66a\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"23ab75475454985b\",\"/knowledge-medium/src/shortcuts/utils.js\":\"dfc0c7eb0c5f4d19\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"d3629e438c3a355b\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"cefcd2860c04938c\",\"/knowledge-medium/src/sync/byteTransform.js\":\"7278f9d673c480fb\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"fe3895b785d9fd72\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"2c4ef151dd31ef38\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"16ed56fc9780c8c9\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"8283d29181e2817d\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"92901de0e304db2b\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"936dd3cffabf913a\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"86395a2d67a17ac9\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"2581beb0a17aa829\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"01e28adb45bd7fa6\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"e81068a404b7ada9\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"96b6cd32ebf30041\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"9c2ff67c9b2c4ecf\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"7d0748649d7cc541\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"f0df8deb03c27b63\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"650603eede671dcd\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"e5a2fee383ca424f\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"291fb2de4e8084e8\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"84ec27397df3378c\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"5171b6afd06ba5be\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"a2aacc9ba279b7bb\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"8995f804bbaa4e48\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"f702bd53782bcc85\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"3a643926e65e21ac\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"9443cff935d16228\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"e5cd59b675553c39\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"f9f0fb3f45d9fe0a\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"e25029fc6f4148ec\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"3699f104a5a058fe\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"a8fde583c38b0d7b\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"e97655ac6531778d\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"5766217f5112c429\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"462915dcb997c85a\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"2845fbf25df05e9c\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"9d84c10b6c58be69\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"933fb693b760cf62\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"3abfc27dd1a0eda3\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"bdf115b9e73adee0\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"ce6a6c410af0db38\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"96f23c9e09f38101\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"0a8bfa1e5ac730be\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"dd6db5ec7ee6e2ae\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"a7be1b8bdd5f402f\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"dae640233f7c6d93\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"958ce6c937fc26b9\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"3666123957e2cb63\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"260397b782dcb53e\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"24cd67d6404243cc\",\"/knowledge-medium/src/sync/transform.js\":\"d156347d3f7252f0\",\"/knowledge-medium/src/themeBootDefaults.js\":\"d1b630094df02b93\",\"/knowledge-medium/src/types.js\":\"ea95e313ed30b425\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"ca0678abe922dbad\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"db1481ae48d8cbcd\",\"/knowledge-medium/src/utils/array.js\":\"6058125cb9ce5838\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"f06c6733fbdf0185\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"6092e05418a11ceb\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"d4a7d624f1d6f424\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"5cf14682edeb72f7\",\"/knowledge-medium/src/utils/callbackSet.js\":\"4fd4d511f45890fa\",\"/knowledge-medium/src/utils/clientId.js\":\"924c7d4dc4f5f3ee\",\"/knowledge-medium/src/utils/codemirror.js\":\"14220472bfa29d9e\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"61d69a843dc898a0\",\"/knowledge-medium/src/utils/copy.js\":\"86c7204e87b6b1ba\",\"/knowledge-medium/src/utils/dailyPage.js\":\"75e9a6396c9871b5\",\"/knowledge-medium/src/utils/dbForensics.js\":\"53972104986e94b9\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"c71ad145e31f7713\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"c371b4ddae8cca55\",\"/knowledge-medium/src/utils/dialogs.js\":\"11033c5393a22364\",\"/knowledge-medium/src/utils/dom.js\":\"b287256eef8910f8\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"6c482b03bd97ce65\",\"/knowledge-medium/src/utils/drawnWalk.js\":\"b3bdce48af512529\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"030c91e17c066a00\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"f53876640d5d2f6f\",\"/knowledge-medium/src/utils/flipSlide.js\":\"452ea7206e854d35\",\"/knowledge-medium/src/utils/fnv1a.js\":\"5aca16625568a00b\",\"/knowledge-medium/src/utils/formatBytes.js\":\"62a9c75c801d0f7c\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"0b0246d2f08c3d1d\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"d7acea84f73c3873\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"46181bc50ec16293\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"c8e8430226ad1dae\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"6f5b30ffe8475645\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"e929019440a61471\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"51c25288fa73a559\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"d9fa7737a5741aa7\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"6004e92705c14df4\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"f83bd6534e0f7d1e\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"85aa7c8b8ea337b6\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"af82f6826e232a5f\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"146b71f981e77cb6\",\"/knowledge-medium/src/utils/markdownParser.js\":\"99b30a3112dc41a0\",\"/knowledge-medium/src/utils/memoize.js\":\"ca387547b2d967f6\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"fdf1ad9b54f030e0\",\"/knowledge-medium/src/utils/nameList.js\":\"89e8e05e8830e7ee\",\"/knowledge-medium/src/utils/navigation.js\":\"493a12036a6c7e47\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"9420171214f25f42\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"4dfeb56ce2badfe1\",\"/knowledge-medium/src/utils/panelClearance.js\":\"0fd407a249195794\",\"/knowledge-medium/src/utils/panelHistory.js\":\"cadcb2dc30045c6e\",\"/knowledge-medium/src/utils/panelLanes.js\":\"a3d31721c8e25c78\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"b8ad354328739c10\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"069c4f2f4c3d71f7\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"a95afce00d7f6b2f\",\"/knowledge-medium/src/utils/platform.js\":\"b3726effc3c263b1\",\"/knowledge-medium/src/utils/pluralize.js\":\"456b505da0b48a38\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"258b08526553e02c\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"79d26a7061fb29cb\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"f1d746484dcbfd8a\",\"/knowledge-medium/src/utils/react.js\":\"e910c305061113af\",\"/knowledge-medium/src/utils/relativeDate.js\":\"a346d061c5c94ab7\",\"/knowledge-medium/src/utils/relativeTime.js\":\"7aacc9f4bc263678\",\"/knowledge-medium/src/utils/renderScope.js\":\"d6231568a8846106\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"db22ece9cfc0ce0b\",\"/knowledge-medium/src/utils/routing.js\":\"1898a5be909cceb4\",\"/knowledge-medium/src/utils/safeMode.js\":\"2b7191786fe12456\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"f74c040c935febff\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"b2f50bfbd9f17c9b\",\"/knowledge-medium/src/utils/selection.js\":\"bad9b633af3a0815\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"a2402b64a8a715f2\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"c8c2087b0917f7b0\",\"/knowledge-medium/src/utils/state.js\":\"b8d494910d182de7\",\"/knowledge-medium/src/utils/string.js\":\"4df062852f0427f8\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"acaf893084d7a82f\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"80c2682c4acd9e52\",\"/knowledge-medium/src/utils/toast.js\":\"22a911df35831bb0\",\"/knowledge-medium/src/utils/toggleStore.js\":\"8533f73bbc8b9d3f\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"bbaf0615c0ed5230\",\"/knowledge-medium/src/utils/userActivity.js\":\"1e974a6ead7e80b9\",\"/knowledge-medium/src/utils/viewTransition.js\":\"581533e6ffc4f430\",\"/knowledge-medium/src/utils/viewport.js\":\"ecb550e855165b11\",\"/knowledge-medium/src/utils/webLock.js\":\"edd98d70b11636e7\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"861fe278a23763f8\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"5830cd4b8ceb088b\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"a74fe0d9516da748\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"6115c0bde31169f3\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"1cba492fdc91c869\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"f2e83b927af5bb16\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"2c827deb66398b20\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"70937a9e9fd66c64\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"e3415c3ece120dd7\",\"/knowledge-medium/src/vendor/react-dom.js\":\"3d609f11457acf3c\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"9875f067531981e2\",\"/knowledge-medium/src/vendor/react.js\":\"be40b91d2d47cce1\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
