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
		buildId: "32e9024edc0e-0dc3c5c2",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"47452fc369cb22b7\",\"/knowledge-medium/index.html\":\"47452fc369cb22b7\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-DgVpU5wt.js\":\"73dac9a72c8b566f\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"cf6405f3aca65d53\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-B-Xw3n0n.js\":\"cce08eeef310ec41\",\"/knowledge-medium/chunks/FacadeVFS-DIoNkYCv.js\":\"7a2280bbda554a2d\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-CmMTiaOs.js\":\"18a7751b079454fe\",\"/knowledge-medium/chunks/MemoryVFS-D7GAIhuV.js\":\"d76415dae5a3e114\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-B2dyUxDG.js\":\"ee6b52753e1e86a2\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-D1tXqoNj.js\":\"e1908aa13a1a5ec6\",\"/knowledge-medium/chunks/Preview-BeXJ4bWF.js\":\"fce819d057d3c626\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-8gtStuJZ.js\":\"92f6c32ae2ba9a0f\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BXsj9Lsv.js\":\"21d471f20f81fee8\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-BvbGzYwH.js\":\"d35b264d92016f16\",\"/knowledge-medium/chunks/react-CDjMl5_5.js\":\"1e1f88f0c82ac7b3\",\"/knowledge-medium/chunks/react-CLX3ebr9.js\":\"97f8830e615ea8aa\",\"/knowledge-medium/chunks/react-CgJ1v1i3.js\":\"3a9fae201660099a\",\"/knowledge-medium/chunks/react-NOdyDD51.js\":\"ff897a6407041e77\",\"/knowledge-medium/chunks/react-RW0KhrwN.js\":\"f547b6d7435459eb\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-D2sHeJtx.js\":\"1d0ef2968d67e8dc\",\"/knowledge-medium/chunks/react-dom-server.browser.production-m1DVRvxt.js\":\"ccb0551d17a7790a\",\"/knowledge-medium/chunks/react-dom-server.edge.production-n9Ros8vV.js\":\"08ba390028f377d8\",\"/knowledge-medium/chunks/react-pxa-_SWb.js\":\"b10835fb393296c5\",\"/knowledge-medium/chunks/react-uDgu_RsX.js\":\"c33dc54f2f07e081\",\"/knowledge-medium/chunks/server.browser-BiENgs4u.js\":\"d7afb9e36097c6e4\",\"/knowledge-medium/chunks/textarea-D-uYRCzk.js\":\"ffcb850ce3063742\",\"/knowledge-medium/chunks/ui-DQHqiHc7.js\":\"8d6dbe661110c4da\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"5041356666c1b861\",\"/knowledge-medium/src/appUpdate.js\":\"0c248bfba8a03c74\",\"/knowledge-medium/src/appVersion.js\":\"65b91363a20e1a46\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"7492182c442c4f11\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"ff874a377738af83\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"e36f5ea434519e77\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"2f60b51b8790caee\",\"/knowledge-medium/src/components/BlockComponent.js\":\"06f255d102bba8e8\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"60ddf6b94ea3b4e7\",\"/knowledge-medium/src/components/BlockEditor.js\":\"779d42003241de12\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"cc4cb4c334468211\",\"/knowledge-medium/src/components/BlockProperties.js\":\"b3e1cf5a5a70853e\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"f3a9a74eea78fbe5\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"8cbde71bb3bacd82\",\"/knowledge-medium/src/components/DividerHandle.js\":\"ce953b0cb7ba202d\",\"/knowledge-medium/src/components/DraftEditor.js\":\"963fcc60ce66b40f\",\"/knowledge-medium/src/components/GutterPill.js\":\"b20a92ec3848e249\",\"/knowledge-medium/src/components/Header.js\":\"52c12ec7310756d9\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"16f2d53c8888fab6\",\"/knowledge-medium/src/components/Login.js\":\"2f5e201fa2f69cb3\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"24559ac476d6e925\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"67f4f7bd206bf918\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"5e586ff705753bbe\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"39ff3d7740e41b56\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"0e1eec5baddcd095\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"d30f5ca428247260\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"365fa438beddd748\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"ed57eb99a16c4e95\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"4881dd3d2f7d1e85\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"5167eef7cf205e08\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"31b822ddd445ed0f\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"55b4c842f039d18c\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"70a8fb41ae33f8a2\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"5d268cccf1b60f9c\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"842c94e9cbb5d82b\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"ce9c1d53a5755a90\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"ec6d7481abec8100\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"42710343b901d06a\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"394bedf43bb9640c\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"6cc605445cd765cd\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"f68ffde2f5d2b974\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"bcbec1caa5aaf58c\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"4fc653a3731dcd56\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"4e7c3558bf5f7abc\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"72fc784f578b5b8d\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"4fd43dbfe0ffa789\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"3926288c8bfe8eed\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"d7153d6f2f6e1736\",\"/knowledge-medium/src/components/references/CompactReferenceLink.js\":\"2996b87b4874cecb\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"4ed3f622bc74e100\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"03a8d3597d14bb78\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"a2d7e8ad21a38c85\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"842e63207d710bcc\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"8874b9cdbec997d9\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"83809bbc3429f77a\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"bf4d112c14b3ccbe\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"3d12d348f8da8622\",\"/knowledge-medium/src/components/renderer/BlockReadText.js\":\"55631780384d27a7\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"b6814158bd00e04e\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"d97acdc8c45d39e7\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"bddc3fdcfd4e4861\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"42bb3ee6fcee249c\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"72799abb6ecbcba2\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"ee8bfd05121245fe\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"4c6f2ee6ebf7fb21\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"071e5c3d0fcf7d53\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"b0433c9f70aae88f\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"639aa4adc0b85799\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"d9eaf29eaa6ca2f6\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"743c355c09a387d7\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"4eead785c36e6391\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"2fd34350e3b812ec\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"fd5e666fd830100e\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"105bf86b249234b6\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"5c694976d2c86810\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"8aa52d9e1a8e7ed6\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"fc9c72df002db47a\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"2b8b0e6ac4104c64\",\"/knowledge-medium/src/components/ui/button.js\":\"b1d30e2f1780312c\",\"/knowledge-medium/src/components/ui/card.js\":\"18ed9cccfe00856f\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"0db9ab90b4f00424\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"aad64de319a33878\",\"/knowledge-medium/src/components/ui/command.js\":\"b6d8cba2c1b81dba\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"cfb5b33e733e6fb6\",\"/knowledge-medium/src/components/ui/dialog.js\":\"889e42525060efb2\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"29547f5961818923\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"95723638e83586ca\",\"/knowledge-medium/src/components/ui/index.js\":\"9a9b2baa77e51a1d\",\"/knowledge-medium/src/components/ui/input.js\":\"2fc8c48d6e2e11aa\",\"/knowledge-medium/src/components/ui/kbd.js\":\"aef910966310ba51\",\"/knowledge-medium/src/components/ui/label.js\":\"543ee90041638a00\",\"/knowledge-medium/src/components/ui/textarea.js\":\"09307e5f76713403\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"8fa7a0d16ff02fcd\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"cfc8e1a601b694aa\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"51f92031d79547e1\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"e4ce33db51692a0d\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"d392243672c68bc3\",\"/knowledge-medium/src/components/util/error.js\":\"bd9411267ff5a066\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"22210c4bde8ca401\",\"/knowledge-medium/src/components/util/suspense.js\":\"86da44f8535ff9e2\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"0c75bb5ab6d9d472\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"35a92f12080e15c4\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"5bb6d6eda777928b\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"3a808bc48a972696\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"2f34d5117da279ce\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"9675f3f72bf6d324\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"a769c80156e27236\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"0a55381085b560e4\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"8340678d5c9be16a\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"38fcd2e8921a8259\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"742b6c133c7bfeed\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"1b22c430d0bd152c\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"a92d79fc90e813cf\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"32c1eb85e8158a9a\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"b5d49bcccd71b250\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"83240494e9dc2092\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"d97b36f1ac1cd821\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"1092d6dc16528d3b\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"6cbeb7414ba1a681\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"5d06616a90615792\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"85b5a232f8ffe32a\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"cca7d58b58e01506\",\"/knowledge-medium/src/context/block.js\":\"ad6f193dde37583a\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"31339d6959071112\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"204ee36e67cd41f8\",\"/knowledge-medium/src/context/repo.js\":\"1591e4f13fd072da\",\"/knowledge-medium/src/data/aliasClaim.js\":\"4143bf8705655493\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"52adcda959c68301\",\"/knowledge-medium/src/data/api/blockData.js\":\"aea4130d0147a0b8\",\"/knowledge-medium/src/data/api/blockType.js\":\"900c93bd2cb35c5c\",\"/knowledge-medium/src/data/api/changeScope.js\":\"4ecd9f278362089f\",\"/knowledge-medium/src/data/api/codecs.js\":\"2dd3b1c89cfca45f\",\"/knowledge-medium/src/data/api/derivedData.js\":\"fb0e451cebb5b25e\",\"/knowledge-medium/src/data/api/errors.js\":\"a91c204aac019eed\",\"/knowledge-medium/src/data/api/events.js\":\"c761179ce013b1cd\",\"/knowledge-medium/src/data/api/handle.js\":\"21c3d8df99b303ad\",\"/knowledge-medium/src/data/api/index.js\":\"97c48e03840d6d27\",\"/knowledge-medium/src/data/api/mutator.js\":\"b9b288e7c43b87a2\",\"/knowledge-medium/src/data/api/processor.js\":\"3509ff1a6fb4d6ba\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"3598eb6691634e2b\",\"/knowledge-medium/src/data/api/query.js\":\"b2afe35f0fbcc033\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"50b497b6fb9585cf\",\"/knowledge-medium/src/data/api/schema.js\":\"21c3d8df99b303ad\",\"/knowledge-medium/src/data/api/tx.js\":\"21c3d8df99b303ad\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"77f550f2aa4144bb\",\"/knowledge-medium/src/data/api/user.js\":\"f80867dd6de43a21\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"9233b0f26bdbc782\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"a716327141705c51\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"a87fe1c7a4ff80e4\",\"/knowledge-medium/src/data/block.js\":\"407483633db02407\",\"/knowledge-medium/src/data/blockCache.js\":\"472e2720fe7d94b2\",\"/knowledge-medium/src/data/blockId.js\":\"e4fa09dcabf123a5\",\"/knowledge-medium/src/data/blockLiveness.js\":\"55476ba881d27456\",\"/knowledge-medium/src/data/blockMerge.js\":\"c640cde67286bca9\",\"/knowledge-medium/src/data/blockSchema.js\":\"32bab4a1f0d3d54e\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"08bc0039d89f9d8d\",\"/knowledge-medium/src/data/blockTypes.js\":\"50a233009e4eeb06\",\"/knowledge-medium/src/data/childrenView.js\":\"b365190032a7205f\",\"/knowledge-medium/src/data/clientContext.js\":\"f57a1c1b96768676\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"6969ecfe8a07dbbc\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"fb8923d02bd32091\",\"/knowledge-medium/src/data/derivedIds.js\":\"4cb2e77c2d3cdb4a\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"9d9251456c9329fa\",\"/knowledge-medium/src/data/facetBridge.js\":\"ec85a31d5b17f1d5\",\"/knowledge-medium/src/data/facets.js\":\"61efafcb84c99d42\",\"/knowledge-medium/src/data/globalState.js\":\"060221ae1609299f\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"20249ab3c15382e9\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"fe63db38787fdd66\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"df6f410548599a49\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"27a06726b9043c67\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"c722e2bdc59b68eb\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"1f64d0b2ab8be890\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"bcadf0322c1f919a\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"b1d8653fc80e4f0b\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"7091ce5e678751ab\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"6fc4fa491b83347a\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"0cf92585f62ec8e1\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"658823d56e73ff43\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"54dca726c6037303\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"1fa7e891987b7bc2\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"33f1e44d2dc13253\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"bfc99a8e8a7e85c2\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"1e80d370ac1a9ab6\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"7953d2602ed12b57\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"16f08b1eda2868e4\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"c6b6c9dd4432236b\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"092cb6b408f9bf8c\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"7f55b3cc735e7f6b\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"2c201cb4ebb87e55\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"5be205b88175f800\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"bf32dda68dccae93\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"c4101e2b9505f788\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"1eb1e60d8801be2f\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"2c8fe10df9e8d722\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"2fe6bd2300972ae0\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"a350dbf3a29f421d\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"75758d12a65cf05a\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"82f081314c576249\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"52ad6bf7633c6e59\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"d9722709ec4de6a7\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"2d0837c9c5fc774d\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"652bf766f50df554\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"0bdf28a4bbc05f67\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"5231aa7dd149f186\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"e54214fdf07e46bf\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"0eb6ce022a55138d\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"ed83c10557e8b8ee\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"28e5fc7cc14d785e\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"5d731c1eee15b02d\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"2f3d3686dab8f698\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"f5ff8f88a2480a0e\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"c683564326e0d6fa\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"604774d4bb16ccd0\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"9b4e76f49164c53e\",\"/knowledge-medium/src/data/invalidation.js\":\"8c62700aca6ecabf\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"cb3d5b37613431c7\",\"/knowledge-medium/src/data/kernelPage.js\":\"f6a48847c14be602\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"661f04e7329db62e\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"6b3a16cee707dcc8\",\"/knowledge-medium/src/data/localDbStorage.js\":\"b4ee275c526ddd55\",\"/knowledge-medium/src/data/localDbVfs.js\":\"668ccd8ddc22c882\",\"/knowledge-medium/src/data/localSchema.js\":\"a9c2b7ca1397f845\",\"/knowledge-medium/src/data/maintenance.js\":\"d43f763179ab8e0a\",\"/knowledge-medium/src/data/mergeProperties.js\":\"5d1f84ad145e417b\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"28f5b7166054e70f\",\"/knowledge-medium/src/data/migrationsPage.js\":\"8ecf8376c7d62082\",\"/knowledge-medium/src/data/mutators.js\":\"b90e108ec97e6b3e\",\"/knowledge-medium/src/data/orderKey.js\":\"786e49c06cf3451d\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"4b406f1b1adf34a2\",\"/knowledge-medium/src/data/outlineSurface.js\":\"0e6911dfcd8a2cd6\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"12172b0498314679\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"c99527dec800eb06\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"0ecd19df1f4b0f9e\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"99d8e7471ab16674\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"400c578b82b6d40e\",\"/knowledge-medium/src/data/properties.js\":\"e4b69a7645491214\",\"/knowledge-medium/src/data/propertiesPage.js\":\"e458d213f5ff0de5\",\"/knowledge-medium/src/data/propertyChildren.js\":\"54f356f25d3dcb09\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"6bf193eb525fc323\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"e3880898a59e7414\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"b6597a6c195dbc82\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"1a405eddee616b76\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"9443b6a8aa6a9c6d\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"5951c87ba6ed9029\",\"/knowledge-medium/src/data/propertySeeds.js\":\"30e13757a890bad7\",\"/knowledge-medium/src/data/recentsPage.js\":\"8a952f0b0c0e5d94\",\"/knowledge-medium/src/data/refTargetComparableProperty.js\":\"b4a3c7cf1988016f\",\"/knowledge-medium/src/data/referenceBlock.js\":\"61ff12d10534e5e9\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"57483f63382c88d8\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"5cb37c648f271eed\",\"/knowledge-medium/src/data/repo.js\":\"ac728b49a22846e6\",\"/knowledge-medium/src/data/repoProvider.js\":\"8d02d9da8a923c3a\",\"/knowledge-medium/src/data/rowProperty.js\":\"282651737fd37180\",\"/knowledge-medium/src/data/searchFilter.js\":\"214b24da118ea09e\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"accd806a897d691d\",\"/knowledge-medium/src/data/stateBlocks.js\":\"0620a59dd9bf90af\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"12e6367d50d6585f\",\"/knowledge-medium/src/data/structuralInsert.js\":\"c567c0ac7e922fd7\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"9b8224e70aacfc58\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"1503c877d2f080ca\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"ed9c2b484685ccd8\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"81364e97b601cc23\",\"/knowledge-medium/src/data/targets.js\":\"9593dd470c9c28de\",\"/knowledge-medium/src/data/typeColors.js\":\"d71c58be1cb6d68c\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"b9ebd6a2295d99d9\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"38868b6a5865b28c\",\"/knowledge-medium/src/data/typeExtraction.js\":\"cac519bdf7518d11\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"486cab42b795ef87\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"0cab7a98420625d1\",\"/knowledge-medium/src/data/typeSeeds.js\":\"a91813cbf79a35e8\",\"/knowledge-medium/src/data/typeTagger.js\":\"a29de78e02d41eee\",\"/knowledge-medium/src/data/typedRecords.js\":\"f89030e81d78b164\",\"/knowledge-medium/src/data/typesPage.js\":\"cef8f7b5803b9037\",\"/knowledge-medium/src/data/userPrefs.js\":\"577e603a97543c59\",\"/knowledge-medium/src/data/userSchemasService.js\":\"85f8c1f25df160f7\",\"/knowledge-medium/src/data/userTypesService.js\":\"dc2dc117b0d0cde0\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"1deaeae04f0a2eab\",\"/knowledge-medium/src/data/visibleChildren.js\":\"e8e8f8648a38d374\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"b74013be1da0346f\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"bab3ba6c1259ef9d\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"2eab15274824c169\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"903db48e09f5441d\",\"/knowledge-medium/src/data/workspaces.js\":\"4c7ca51490b2e5bb\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"45c93dc8a2fc009b\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"087f7459f85cd5a5\",\"/knowledge-medium/src/editor/atTrigger.js\":\"065ffa90024f6221\",\"/knowledge-medium/src/editor/autocomplete.js\":\"3650af342a4cc82a\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"80e7ea00141b94ae\",\"/knowledge-medium/src/editor/contentFlush.js\":\"498c58ffbe5f894a\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"90733687c51fb3b7\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"075a922c94abde9c\",\"/knowledge-medium/src/editor/insertImage.js\":\"54f15ef8d20356ca\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"676099ff68a42799\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"e8cabc6adb195592\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"a8095574462971c4\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"383e528d7b2428c6\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"ddddff4bf1ce33e2\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"59dd83fba64972e5\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"64511435171c7c63\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"5ee4556254085136\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"b48633da321dec10\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"85cda59cff577c23\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"9a74bd2c8b8b88c4\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"dbbc8f4769cc0d3b\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"e439349bdbc38f4a\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"5d58c1428ae2d625\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"353f89137f3ccd1d\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"18728fef0393d524\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"bdc1f7ab4e471576\",\"/knowledge-medium/src/extensions/core.js\":\"161158b22c5c1d28\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"036c359a18f9501a\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"b45d5da067b79305\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"134d7631fc484bd1\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"a22c47ddf305ffa1\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"8de763269e717c20\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"f0f42e80dc9f1770\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"dd40d4d05e78c3c7\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"572325ee9f2a4d56\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"56e6b70e5343ed68\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"752506d3ab4f2089\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"7346a7f58f098ad0\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"4caf23f3cc28e7be\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"1d00a814889e457b\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"04247305b4afbdd8\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"7e1e5793d2a2fe0f\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"62ef0f6c4a3b388b\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"c2ccffdb197fb4b7\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"f8a54c3437013dd7\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"6bd0e14878d92e74\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"2f4a097adf68430f\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"738ecca635f5aa5d\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"e7d3292d20414971\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"ade080bff65b63b2\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"fef2834e2aa8b9a5\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"6fab8c35e2938112\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"caf7b10adf6c07c4\",\"/knowledge-medium/src/facets/facet.js\":\"bff4614455971238\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"259ff651953d0290\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"a76fc31605e4fd11\",\"/knowledge-medium/src/facets/togglable.js\":\"d5a3ebf40ff55928\",\"/knowledge-medium/src/facets/variantFacet.js\":\"ef230b920198d715\",\"/knowledge-medium/src/facets/verbFacet.js\":\"fab7264af75151fa\",\"/knowledge-medium/src/hooks/block.js\":\"da166ca0016e472d\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"45107a900d84bdaa\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"fae33eb078521808\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"0460fe5ed4894731\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"ca3d98b533afc955\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"ec5221481006be4e\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"7943f20e7e1fb28b\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"469d31a79c78e5ab\",\"/knowledge-medium/src/hooks/useFacetValue.js\":\"129ae6a8588be725\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"fdfc9b48ccbe31e0\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"cff312a89a5200f7\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"495ec796bd2e613f\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"d14f8c4d9832d1ef\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"ac0f20e369172ed2\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"c701237f4ed7ca3d\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"f80511813694ddad\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"396fbebe37788da0\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"e2293deff56450cb\",\"/knowledge-medium/src/lib/utils.js\":\"1bb9de3fca464a08\",\"/knowledge-medium/src/main.js\":\"f73d1de91de1e06b\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"0feadc942e71f30b\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"745abd71194b7049\",\"/knowledge-medium/src/markdown/context.js\":\"794ed6f6614aac9f\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"9bde8e2062fac492\",\"/knowledge-medium/src/markdown/extensions.js\":\"b1d6964043faf42d\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"5c94b0f993100c70\",\"/knowledge-medium/src/minimal-editor.js\":\"0093bc7a2e6e4514\",\"/knowledge-medium/src/paste/armedCut.js\":\"030672a9010e34d8\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"7d6d7b62a422ecee\",\"/knowledge-medium/src/paste/clipboard.js\":\"53cccf51b366b8e0\",\"/knowledge-medium/src/paste/decision.js\":\"d7ba16d3529748e6\",\"/knowledge-medium/src/paste/operations.js\":\"c57a13fe7f2a7cb6\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"9f70d57ee01c38f4\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"a33fd86b4a8a2b9f\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"3920e57e280ccbeb\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"27195176c455ea0d\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"8b405f5af25a13c4\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"166738fa36842dd3\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"77fb7af594e7b3db\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"f18983df5237b919\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"cf2041b258e6dd7b\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"9cf0135a82dd5ee7\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"c0a60d6874cf20c7\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"d3ccaa1cbfd1a4d0\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"dade0ad9dc0a80af\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"7a666323ce4ad090\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"82e571d70f24ecc1\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"a947654de34c1916\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"44ae1d15e45221ac\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"97fa764cac48c081\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"3e7208b48c6746b3\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"4a45ec040592ef4e\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"8355fc4bdbc286fa\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"ebc4d5a3aa776ad2\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"82a6c86bfed75eca\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"6fce2d914e65627b\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"3c968bee7643bc21\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"07f340ac94cfb073\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"55b30ff446d24b3c\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"e30635eebfbffc26\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"222bb3bf59fe450b\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"3f504cefa1d22644\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"8f7767cc1aca15dc\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"15ebbe50ea5b49a8\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"475d69e086c5afb6\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"7aedbcdaa38bc3dc\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"936359282cfd355b\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"73dc033ed226d11e\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"4ab606d4b762b9bf\",\"/knowledge-medium/src/plugins/agent-runtime/dayPropertyInputs.js\":\"3eda26cab9db7cc8\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"d77f214b9e8d3f5d\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"e8ce14818bfcda2b\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"577bcf61409353eb\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"aeb74006ba2ab778\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"079b96ba31a4940f\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"6a5cba86e673429b\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"99dff9e3e017395e\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"21096628cb1d3878\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"dedfc9507d32881f\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"695497070a666268\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"d120e74d6cddae4d\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"1913c1d54866b931\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"fc78cc60db9372e3\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"b331b7c15fe04973\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"5b2b7799181bcb16\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"0e7846bdb75b96bc\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"98266c47026fd285\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"bda9059be6b99675\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"a1370f90b18df55c\",\"/knowledge-medium/src/plugins/alias/index.js\":\"9b87553493147559\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"2ef585c3315c9774\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"fb4ec461d9f02127\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"0828ea8cb4691d63\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"a4bf3ecbe5a8d89b\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"24712613ff67e523\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"e4b4d0fe8aedc626\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"4b81bd068ecf5c98\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"5a1a53d4ff37bc06\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"e24a67cc8a00dcef\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"d937a35dbf8b8dd3\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"d653c941f8e96125\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"40ba1bcce695a364\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"147c29f13fcd4a38\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"10c246e437526e88\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"41a5d59dd4d5c123\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"1db952798562ce6a\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"867e1401a6618b31\",\"/knowledge-medium/src/plugins/annotations/marginAnchorLinks.js\":\"3f57bd4370b098a1\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"fbbf0dcc1f2f6976\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"be449041d88eee04\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"178b644f950b833e\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"f9b87badc1307a86\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"18eaff4de00c68ce\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"6a1245605a8ae581\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"21387fcb124221b5\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"1a664d324ba1c04f\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"48ddd0bf4be64c1b\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"1d152e1ec1316ea7\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"b3d3dcd7fe44650a\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"4e1c69647f7dec5f\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"48144c4b3dd16bdb\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"de226fbeba1a0def\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"6c6e4b67ac390c0c\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"23fb2f8b73db02f5\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"ec2a859eb222f24a\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"37030f1700cfd8a0\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"f76a1ec9421b5c6c\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"689b13685dbb9948\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"e2541e5cec53a3e8\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"823ad5556f95ef65\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"21e8bc46b688df15\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"e3a07017e0152fd0\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"2b861437f77806c2\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"bad14b9343290365\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"e684f4aa1020dc1c\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"5d8c55cbd9fb8b25\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"759a33bab0c969e9\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"1bec7ca899e5c1d0\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"e1f6cee8f6a67dd4\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"ca07e82b1f0b9838\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"1d13c68b45a6dfdd\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"625774cc403e4dc7\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"e26efc2ad444c1a3\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"4cede3fd2874c62d\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"60c7242aa43a0dc8\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"b65f84ab4e369066\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"d593c22173cc4204\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"8b6a21aaa4094156\",\"/knowledge-medium/src/plugins/attachments/browserMedia.js\":\"923ea37e479c68f1\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"743a6f0b4dca3cd9\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"27297b789ff92a6b\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"96908b0cd174bdb1\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"21600f15fcb335fb\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"79a63d9f86c4ac9b\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"ebbe8ddd2c424635\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"8b433c83bc736c88\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"60f929d83bdadeb5\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"7179c060a8feafb2\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"d9735af36ad472ae\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"bbe68d1097571aa6\",\"/knowledge-medium/src/plugins/attachments/mediaLanes.js\":\"f815c67635087a67\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"f056da1dcb31203e\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"af6a12a77b32b515\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"9a845bc37e117f18\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"77942e52cfa0d18d\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"6c296632148d8adf\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"3cd32ca63caba6d8\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"72daa7b120a554d5\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"ff98f83cfc5ab7f6\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"52ea6a941780d7c3\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"847818ad2e036245\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"8e61743301b62e03\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"c7c894ad36a4becd\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"cbcf8ba40eead64b\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"69cf8e1f3a818a5c\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"d20f7570800a99ae\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"0b5abcfa83ff139f\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"8a0e3d805c30abc4\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"919196e71bfd5dee\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"f3f584994e856ea0\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"5c4f31826390213d\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"1ac6b0cdf5e3ff69\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"2508686f38d7cd88\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"e7fae77c8eceb80f\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"0cbbccc5f4de5ba7\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"c86583acaa33051b\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"be1bd2c0cc905fd6\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"353bf742b7ac0a2b\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"9c816280bc46b3fe\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"4ed1888c992af433\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"dde24a5ac3615895\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"c239cd1f873e44bc\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"cb5d76dd741e02f2\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"607c83a3649cc18a\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"2671b3899e2179bc\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"3603c525e9f942b4\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"ddbee5b380552971\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"08601167c06534df\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"15692bb140019461\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"003aaefad9c1469c\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"9927518bc7efd14e\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"91c7c15e12179e97\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"23c03f3c305dcceb\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"528df494d471e11b\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"f329528cbcf900f6\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"13335f8e0575c03c\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"6f06623f0add9e05\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"34706c99513b6641\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"def516a7b78c3996\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"62c46d2933b7ccab\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"f25b7dc0f12ff9f3\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"68ab3009730af3e3\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"80fb42ffc7de68a9\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"212b830d72f58c11\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"39a312917ee4d6df\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"dedc25fe4f52cc30\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"3883999800e45cd3\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"d8680798f25b85c0\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"8808be46a545eec7\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"e5bafcbf732c586f\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"7b757a189c560ac4\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"b3a82497c83e29a2\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"9de91739f68d0066\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"906b19df8f4de462\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"130daf1df2bf30fc\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"ca9af27b2fcd6807\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"dba4437e52ffd07b\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"3a1bd03458e77688\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"9a4b9925bf68aa60\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"5c38e67c67f0cdd4\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"62d2b2a40451d68c\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"d27c6638348c54e4\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"e7841b3ca55b9c88\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"ab11cbca6727023f\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"9d06ac7eb1d736b4\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"46becf841cc1107e\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"502153d2c9f87e63\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"5870759ecfb2bf77\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"7f2f20f92580d23f\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"3b567e7fd800ce50\",\"/knowledge-medium/src/plugins/character-counter/subtree.js\":\"97d831636144393f\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"66841c0582acd675\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"363b7e5463a95ecc\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"82059439b272b429\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"6fcfb366fd867b8e\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"c5b8266db2e7d35a\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"fac19beb05f47963\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"ded6b76bf30ad5d9\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"3232b82766f642ad\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"c9fd262caa13ce3a\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"8e2eed5beefd346e\",\"/knowledge-medium/src/plugins/contributors/ProfilePicture.js\":\"0016e29f4052850b\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"efbbc2b2ef096287\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"48b4c2a4c1232e7a\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"bce87c2aaaddf6d8\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"b0469a42a644650b\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"2c59875cea8d04ab\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"683296e2f08d7dc6\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"da959ccc5287db0c\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"c985a8e101d29a11\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"286391f3900ba3ab\",\"/knowledge-medium/src/plugins/contributors/useCommentAuthor.js\":\"05aa57e4b00164d6\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"b8687f59866fe581\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"8cde6dde287279f0\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"89ee4375c7c07d91\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"7ffeab397530e74f\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"90c22d7f14ca5cf2\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"11a348317314d2e2\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"82ebcc4267d769f0\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"476391ea5b362355\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"aec240e1333265a7\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"a8b898ef78c5e9a7\",\"/knowledge-medium/src/plugins/daily-notes/DayPropertyControl.js\":\"1af0b72187e89481\",\"/knowledge-medium/src/plugins/daily-notes/DayValueReferenceControl.js\":\"349e15389e1019e3\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"9c19dea0f4cd649d\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"f6224e68cd693a52\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"5f4bf41b8a23d0b2\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"8c043a2ef2106b2f\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"2f8fd9c84696094e\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"d092ce8ef6d9b97c\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"d4e02dee152d9ec0\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"14d4b94c5bced760\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"fdfd1d65580e1b42\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"d75a75f0a5a61872\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"53589dcd13b2520e\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"955a62b6bfa36cee\",\"/knowledge-medium/src/plugins/daily-notes/dayProperty.js\":\"f6f7b93b76458485\",\"/knowledge-medium/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"a3469847ace2db2d\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"4df6a9c9892b505a\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"54c0f109a55f27f8\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"5bb434705bef1e6a\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"5fc5637fab9faa1a\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"176feaae4ce6385a\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"718833b8cce2f444\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"6823963b6085d374\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"127edc3bdd823c47\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"2e0257e6208b29dd\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"f1a79b9e8bbd8d43\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"3256c761614630f2\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"fca575a761970dd3\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"5d6f64e13e3af829\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"c03457cd39156440\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"07fe64d68b089b1e\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"934d99ad93ea7de2\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"2cd8866cbb51b03b\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"97ecba82858904ba\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"96ce502ea701d975\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"e6dc0bc52712674b\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"e4f789d56910e11e\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"f3a3348c32a5c886\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"43225ff2ff314e3b\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"ab727b3f1e94d3cc\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"58c2a15b4d403838\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"f700350b113f6eea\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"f87bbacf8a501f64\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"3985c9097b401ea0\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"0a80486f367153db\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"a5aace6e1788b665\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"1ba596951a40ea92\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"822d125c1b9544f7\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"41ca33786f79a43f\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"54ebbc2e21db3bba\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"ebcdd83bfe4d4197\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"7ab3cc8600616703\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"4d08830760c7f806\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"8aef5972711bd76f\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"33284f8a4d176f85\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"962d2aad4bcd1887\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"b94c322a94e5d4ba\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"88dd3fded844ccbe\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"0f2e13f45dfcc7fd\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"5805a56e19483bc5\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"6832ae1089740c11\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"1feaf87cf9bc0894\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"03813ba5a68f5259\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"43ccbac1dab5e268\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"597a9d256feb16be\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"f60a559cc4a118bf\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"c9f2636b5b59e930\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"e1a4c750fc47b0c7\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"afa5b8a8e05feb28\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"7dfe2af11adbae38\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"de35c4b94faeade7\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"2970d5991814a9cc\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"b740c80008d6ca1b\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"66f708d83b290b23\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"c2ea88c99b8eaab7\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"a465e5125d0ee153\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"84b39f262858d0aa\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"eed3a07f73b9fa11\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"feb77c54b9f31dfe\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"2e40926110762377\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"9d198ced0addabb9\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"758b451a291317cd\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"b439756d509d96a7\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"bd35e8d6735a956a\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"ad08fb1be23f3b05\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"74458c5bfcd47fe7\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"8d6b6538023873bb\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"d5b516efda1f032d\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"dbf116ae60b42aa9\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"076c9b3e6a13e7df\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"58dad54da297efea\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"96d484c4aa4aced4\",\"/knowledge-medium/src/plugins/geo/index.js\":\"0e5efb50a2629e85\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"0586051789f0c451\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"537c68140109c39a\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"be27d2322b233361\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"26cdfabf30af6004\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"ecd1b574e2720c59\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"b17357634579a094\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"448c3148bb8add93\",\"/knowledge-medium/src/plugins/geo/query.js\":\"fa75e35cfc35213a\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"87eb25d73d8b8bfe\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"a62522ab96bdb621\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"3ca400b2f90ed5e6\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"81213689e2c145a4\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"8f66eaa9b15df9b0\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"ee0599575435c1cb\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"6187fac308799b0f\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"8ebdaeb902e4abbe\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"6542c6ad5c604166\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"87e508d2cf777b52\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"73f2de7231de1b3b\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"2f28465cd947a0cf\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"34fc738158a482ce\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"e5b3640241ebc845\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"9119774df587ecb6\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"78cb2c1f14952391\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"6101616a683c392d\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"d4b937d01f258cce\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"d1d7a8f659cfea39\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"865be7ae1f3ad7d9\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"4a4dc48d4a8c6fb3\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"9a3621b5b70a5a25\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"7d0ea8cdb25f0fcb\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"d2c9317f785998ae\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"9689cc2af30a7dde\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"f43d56d28ffc3235\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"645e52c1ed9be3b0\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"2d201845f86aca1b\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"d095fee8b2f4c8ae\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"af4fca16742b89de\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"dbcd4580cc47b56b\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"3da9894bd2aa9a7c\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"bcb4cc5cc4f5747e\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"83d702c6f5b08c48\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"dca719dc29819f85\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"99e30bbc7d9d3c35\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"1b182ec98cddb7de\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"7990db64f9642653\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"a7b6fede7c5256cc\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"6e4bb808ef17f642\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"bd01b74e4a889d09\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"9cb0e3a1033b6fe6\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"92ad1fa06a34540b\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"37563bbe32d382bb\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"65b71f9cb2198cbe\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"3c6bf30769350f74\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"3b4fc6ee6db76bc7\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"044cbb44541a27d8\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"7d960c20a74826dc\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"5b1a8af3e2c2d898\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"e48424ceeca3bead\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"6bf42e50ea075ad6\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"9f8fef2ade05bc28\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"38ae12a231c340f4\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"57f1cd1a28b02385\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"a68fc09cd7f07901\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"813bba6d2a5eaf2d\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"133c1feadc74aa27\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"34dedacf7301fe09\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"a92acc930f907439\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"d026d09a202b5bd7\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"aae07f9982807626\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"d0961d366d229f01\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"13976f934a50648c\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"c511cc8e70b439b0\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"88558793cbb2bfea\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"d6e5862151b7fc06\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"034a84351e9446ac\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"c60bb141d826d86c\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"4774f24a8f7b8cbc\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"6016a0f4d211a60e\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"69431c6da07044d5\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"49c94da700c055ff\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"203b95cdc4c18fea\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"e7bff2db7381d203\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"348a2d1bb4f60b8b\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"10d52178f191c911\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"145dea76fd8522af\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"1b635001841e4f39\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"39780eff737a7044\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"773acaaa3c143898\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"7386d93ede585880\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"212f560a20ae629b\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"9bf90b3ccc652096\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"8f35557aeee2409e\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"8de16e46352a5291\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"f3ed0127c6ec7e7b\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"8240bdf2876350d7\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"1e933227a2f7e9fb\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"74713579529fa693\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"bc7f7e18a142c011\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"10121bc7dd1d48a0\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"80e47b4473e6afad\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"c47ce8ef7f9c4b7d\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"2074e3314df7ea74\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"a4bb361ea3aac09d\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"c7f4052954d3ced1\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"701df4669f257486\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"c8b1fdbeaf070480\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"50a3ea029a3c174c\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"74249acc3105ef54\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"a4e259303089fa0c\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"b668e728f9df532e\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"fd6624110f1e03d6\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"8263aef861ae8328\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"24d7046fc8d68251\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"957c93b0f021aa2f\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"5eb9646bd6510d2a\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"f6aeabf63b280f37\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"f08c9388d3e1d2a8\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"d36936d8f4a9ea8e\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"f84bcf870a9e18fe\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"f9da9fb91f919a9c\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"65583c7393cecea1\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"cc20a79cb2960f34\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"0274ed4a53cb88b8\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"d942fc5a723537da\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"be130651d507df84\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"f8a4e02ef970162c\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"0bd0d51f3b395caf\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"6e798e969efbd3d3\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"e8ca10db4da356dd\",\"/knowledge-medium/src/plugins/recents/index.js\":\"5d02a04b971f5708\",\"/knowledge-medium/src/plugins/recents/target.js\":\"d6139c521ea14312\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"ae894e1524abcefc\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"c01e3cb1bb57f87c\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"6a8bdb93c00a324a\",\"/knowledge-medium/src/plugins/references/index.js\":\"c2f1b38058cd1ff7\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"14bd557a3430c11c\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"a2cc497be284d7ac\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"4ffcead25cbda5a2\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"43848060977fd0c1\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"3b94afb92549479a\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"142aec171694bfa9\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"ef45aa98a3e3a961\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"d66d9d9b202a2c31\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"14e1bfff889ee547\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"1b3ed62afd4a0186\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"32cf084abccc8f67\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"bcea9a9a9cc26e81\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"17ffc68184721559\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"11864277758a0eb1\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"da57e808e7a2c5d0\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"b25c8b2cb2f57dfb\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"7617860afbd6f852\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"a40d42bbf7fc3188\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"99ba26f739e8a7b7\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"2fb8d811d1c28f15\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"4d89ad2d97581164\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"91e794bee084987e\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"9766176a8a27398d\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"2b0b02ce26d3f8de\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"7e9e93a00e70cc1f\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"154f7141fb49b058\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"56c968cc8307fea7\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"eee62400827e34b6\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"12db319112e05d8b\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"b10b0c6e5e3eab5b\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"67f5ede29db319de\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"3ba00d4ffbb382cb\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"f5377bc65dae25a5\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"db602c65ca3c2ea4\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"c835efa154e142b8\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"954a7aa03de0adfb\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"b8c07449df9e3482\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"5b29442d655ab6b5\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"59fab9997b8c5696\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"2a7ed5fe2272544b\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"c8ae8dcfd828531e\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"48c17d088bc856c0\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"95eda5724f19f75f\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"6bbeeadc62dbeb55\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"ac34f64b2fb7c3ad\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"aa875400cbfc51ef\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"33cb8597e75b7093\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"c6903917612c28b7\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"8c6d1709934a151e\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"0d4f0e1435267960\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"79119f941a84bcaf\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"a4bcfaa431c0c70b\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"4aa6149d7df0c013\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"ef550d67b3919ad4\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"19e99499d06e5460\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"39583c832c655adc\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"54e571759c8c511a\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"c5b5b16442b97942\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"4f08a7bb150a6011\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"c19938bb86abe642\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"e608f4f8622f8e1d\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"9ed29467b03cdd9c\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"e122dea1988d14f8\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"3b9d0c92b7a138d8\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"8dc41c2c3fba880b\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"97fe83ecd562a06a\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"da24b85f1f07a76a\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"d8aeed5c84ad94f9\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"f62edce4e405a58c\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"50702976cecb2cd4\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"7f47cf98b802aa47\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"21811b6cfa2d1a21\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"e9d1cc94c388fd72\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"8ee4d448db914055\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"19533df3c8c06613\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"63b7f857daaaeefc\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"3c0f4c1d14d29a14\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"b8fe4bddeae264ab\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"2edace3281061951\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"04cf2ddee29e4336\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"04cbb56148b56e74\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"446367245bab0aef\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"c25f19884910e25b\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"8c4e37928507fb91\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"449408b043d72b7d\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"0e7c14af55a2deb7\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"b10a84a98c8d5c0c\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"2e338b4c6de62df3\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"d5a1d4b9304b7f09\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"66c39cb79a552a90\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"e852b2ad575aa397\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"e55235ac8ce83513\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"60846457e285ce53\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"f43daa875bd642f4\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"1552425e7e23f8c6\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"aa01f3e63ddfe364\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"6bb2d9c902ed0f6c\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"363f8a20c14ba53e\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"7a277c8837ce4087\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"f99ec6fe4ebb1e18\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"4fab57a285abd75a\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"fe974979f9071379\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"0b1cfed95d783cfe\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"c80002d865156682\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"e2ad185c044ce0d9\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"d8268b622339f897\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"5c24b0e040f03fb9\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"95f4fd72ac181b06\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"006f7f3e5e65e4ec\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"66940150ae9b4890\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"d46100dfb18cad89\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"271e37afc38df23d\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"a06f5d15e32b586b\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"fdb7052c1671864e\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"834dee6d425b039d\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"546c8c9972eb32d7\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"d2840c8a551c5f68\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"0a76c32bdabc00eb\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"da74a10b96b09ef4\",\"/knowledge-medium/src/plugins/tables/childrenViews.js\":\"c1c44c742f58b7d7\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"f61cabdf06a6ea22\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"5ac585e842f231e6\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"47ba0513f9b98c46\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"a51db89ce98507d2\",\"/knowledge-medium/src/plugins/tables/index.js\":\"08073049d01ad6cc\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"43270d39e9b9b5cd\",\"/knowledge-medium/src/plugins/tables/model.js\":\"ff460445be20f784\",\"/knowledge-medium/src/plugins/tables/query/QueryText.js\":\"afe55e01ab7a3bf9\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"b806bb4218c4548a\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"d25fbcc6bd135273\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"80b928ab01da3731\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"490210f8dd9bcd11\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"988716127f3fa772\",\"/knowledge-medium/src/plugins/tables/query/registrations.js\":\"965af0f72664bad3\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"a5ffcfd7522d4cea\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"89df72de3cfeeb15\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"b2133d0f613ef1d9\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"acdf280e2acf3da2\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"b180e5a7ad37038b\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"a4a5b5ba58835711\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"83fb54d456deea26\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"a0a550eb3af37c63\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"2e1f3273364b8f0a\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"144668aa813bc53d\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"940b33f659ff4ebe\",\"/knowledge-medium/src/plugins/todo/index.js\":\"de57b2911c2e3c64\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"23f31d19ca1869ba\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"4d7382d664d4b91b\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"b2f40a72d9590438\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"56790da9ec817e9e\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"74de656dd873b6ab\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"082b16b6ce15df82\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"10f90cba51e28d76\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"37ccfffddc718346\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"3dad72dea4e31a5d\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"2da0b2da9870384a\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"f8099ef88688a65b\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"65077e3e46fd003b\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"6f4e07607d007e4b\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"ea5bf4d7bcb42bbc\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"3d1b76bad4b2bbe0\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"b3e8c16c0535098a\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"ab24648f3064f539\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"5faabd1b1ab4173a\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"dca5e07fd8824126\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"39c9903d6f99bfa6\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"38835c1d8bdb2b83\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"ea312cec834d5661\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"487ad746d3c7e61d\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"7ccd110b71b05e1b\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"55096b38bb12e324\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"fd4f5fda6254da1f\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"1a667c537160c602\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"9a2e1b82020dc6eb\",\"/knowledge-medium/src/registerServiceWorker.js\":\"33c49f71f937d5f4\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"8ffbf12b9c2f1c28\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"045d68c17002ddb2\",\"/knowledge-medium/src/services/authStorage.js\":\"427e49d29bff0453\",\"/knowledge-medium/src/services/powersync.js\":\"cf3d59edd6489229\",\"/knowledge-medium/src/services/supabase.js\":\"6aaefeec8c17d873\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"f1416ca3884ea445\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"18070bc09b5feb5a\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"c9a3c510d88cb8f3\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"40d5f64fa9ccdbf4\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"51d6f6a064c8940b\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"bd9e2b29b19d3daf\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"be00317d46faad75\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"ff9f21ccef50e0d7\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"151c6c6262fa1634\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"7899bf6313f1474c\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"c7fcde999b5699d4\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"f15288b10a9d3278\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"868eafc3c153ad26\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"ee2e1c0c6432684d\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"0a03d3f653348f19\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"fd48fefe8e061c33\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"d13b65e1636b5638\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"436384ce516ec358\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"ffd353144786e087\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"1ed10ae29b62a480\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"01d85d4dd5ee911d\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"d74f20128b4a86e0\",\"/knowledge-medium/src/shortcuts/types.js\":\"ca7b4ece2ec40009\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"b76b2f62e93eb3b1\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"fb57ccc104ad63df\",\"/knowledge-medium/src/shortcuts/utils.js\":\"d896d89ccc643d68\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"15a45a313b397154\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"2ce39be05f26bcb3\",\"/knowledge-medium/src/sync/byteTransform.js\":\"1f42d9ca7357adc9\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"39379192a0cc26c5\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"b7ac55a542b6c2ac\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"03ab17b82e1e0f78\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"6b06b42454b73095\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"4ff65202dbb2c7a2\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"494fbc730969de8c\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"7ac8c81277b02db8\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"c4cd1a3333b330c7\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"ecd91dadb0207121\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"a4067afc19714c85\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"13b6d400e34c19d8\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"be7c23522be25190\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"3f1b7ee9dd7203a1\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"141c1231b9f872e0\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"49afaa6ae8204fa7\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"fe19d8d4f023496d\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"85bdbdec4a00e249\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"c449c63ccfabda36\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"7f35b9e0ce461c97\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"4e7d507414a0e474\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"ea199b96f820881d\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"b8ed8c3eda8b93f6\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"5e924abe74e5f44c\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"eda4f9726f81b64d\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"731d20a6479e953d\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"a84211a61b552024\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"97259122220e4ff7\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"1b15b20d27f72b04\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"ad0821a23fd45618\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"0cd2e6da65c3479c\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"4d70cf6d89dd2454\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"cc1dc298a1e039d8\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"6d1a0eadbb27afbb\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"44163069b5fb1946\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"c4d1be300999e1d5\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"857192ebd777eaed\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"962bfef60b0fe8df\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"8b7957964718d78c\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"57903323134e9e97\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"94620c21416e1b4f\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"24b725fe6adf353a\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"a64035c149322669\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"4b8c855b011a15fb\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"45fbe0230a60cacf\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"31c0f1158bd9d28b\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"aa4cffdc5591b700\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"e8c1eafe28654dc6\",\"/knowledge-medium/src/sync/transform.js\":\"5a71c6b1f501dbed\",\"/knowledge-medium/src/themeBootDefaults.js\":\"e1ff208bd3666bbd\",\"/knowledge-medium/src/types.js\":\"2bc0cad476705c1d\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"bfecd71c5f214f37\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"7ca6d403ecc3a096\",\"/knowledge-medium/src/utils/array.js\":\"29f6741d79aa9c64\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"1180f9f4e9497ae4\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"58299a6c105d41c5\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"efe50799564964b9\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"4242d952d82c2168\",\"/knowledge-medium/src/utils/callbackSet.js\":\"a77f05e76adaea32\",\"/knowledge-medium/src/utils/clientId.js\":\"927a97111e152d3a\",\"/knowledge-medium/src/utils/codemirror.js\":\"cb542b49d035bf05\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"8313243c086cc3a9\",\"/knowledge-medium/src/utils/copy.js\":\"ad324e86f5ac83b1\",\"/knowledge-medium/src/utils/dailyPage.js\":\"94ace6c88dee4609\",\"/knowledge-medium/src/utils/dbForensics.js\":\"0026fb5238a0a7aa\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"3e20d6a4698ed9fc\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"307c0bce137fdd6b\",\"/knowledge-medium/src/utils/dialogs.js\":\"2072ca113fab8aca\",\"/knowledge-medium/src/utils/dom.js\":\"7bc38ce7207d0e17\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"ee55509440074c99\",\"/knowledge-medium/src/utils/drawnWalk.js\":\"9d27294091a5b559\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"97aa0daed28122f3\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"864b889ab1f61da4\",\"/knowledge-medium/src/utils/flipSlide.js\":\"bdcfda147b246de2\",\"/knowledge-medium/src/utils/fnv1a.js\":\"6a6db8504cbda46e\",\"/knowledge-medium/src/utils/formatBytes.js\":\"1d2f71d1baf7c0ea\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"f97bc8df7dc533c5\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"deb4979c217d3561\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"eb574082fdb7d3f6\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"a8b73ad01a89d989\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"ac3af80028636f06\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"e7e9d8cd6ce93a4a\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"77a2e0d5f2c1db0a\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"5c775f31b644ec8a\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"8c3fb8ec9420e6a3\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"f237492abe5422e0\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"830e1dee30d0653d\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"7b81557ad110d4b1\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"dff0f55fe3688b60\",\"/knowledge-medium/src/utils/markdownParser.js\":\"6831bfcbcc517898\",\"/knowledge-medium/src/utils/memoize.js\":\"d773befcf329a406\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"a11ceb40197585f8\",\"/knowledge-medium/src/utils/nameList.js\":\"53a1665e7d9ceab9\",\"/knowledge-medium/src/utils/navigation.js\":\"32325c47d72933b5\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"a7eb65acdd404eb9\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"7c8d387304260cdf\",\"/knowledge-medium/src/utils/panelClearance.js\":\"1169d22150d425a1\",\"/knowledge-medium/src/utils/panelHistory.js\":\"76b9272822c4ee32\",\"/knowledge-medium/src/utils/panelLanes.js\":\"ff876e699c30a332\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"1287a4087340c32a\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"19d93e06b8657bed\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"44d17bfc938239c7\",\"/knowledge-medium/src/utils/platform.js\":\"020499a4813cca27\",\"/knowledge-medium/src/utils/pluralize.js\":\"85856424d61b58f3\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"a6ac098c3ff0206a\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"1e6cd504ec58ed9e\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"8243f3eab54f00c3\",\"/knowledge-medium/src/utils/react.js\":\"f5c7adc6d0558fab\",\"/knowledge-medium/src/utils/relativeDate.js\":\"d2e419f4db6b1a7c\",\"/knowledge-medium/src/utils/relativeTime.js\":\"9ecc0fb0911e9ea0\",\"/knowledge-medium/src/utils/renderScope.js\":\"ac626e2f3d0937c3\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"d529892692db7d7c\",\"/knowledge-medium/src/utils/routing.js\":\"307fc25c26b128fc\",\"/knowledge-medium/src/utils/safeMode.js\":\"e70478bf6feec96d\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"ce8eb8321f55adbf\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"b4b9084614c04b8a\",\"/knowledge-medium/src/utils/selection.js\":\"da9fc4e10057d7e1\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"cb0ae6a7a51d1edb\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"654a08b2e353dfbe\",\"/knowledge-medium/src/utils/state.js\":\"075f2b7a39f650b7\",\"/knowledge-medium/src/utils/string.js\":\"8d00e005a5035331\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"258bfb7c21b3d961\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"f8dcf3483c4a3d4b\",\"/knowledge-medium/src/utils/toast.js\":\"8de5b845999c4598\",\"/knowledge-medium/src/utils/toggleStore.js\":\"84b210dfaee9c4d0\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"8ff6c4cd808dd7c9\",\"/knowledge-medium/src/utils/userActivity.js\":\"54204968eaf10234\",\"/knowledge-medium/src/utils/viewTransition.js\":\"cf012459300f9de7\",\"/knowledge-medium/src/utils/viewport.js\":\"90584653fc000e2d\",\"/knowledge-medium/src/utils/webLock.js\":\"ceb87c83913363a2\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"f79b3929c123e85f\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"4f93bd6c5c6fb059\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"9387c03a0c3b9d7d\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"45c1023d7ff894cb\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"73f77cf70b565dbf\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"25e2712b6d2f5a0a\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"b048fc309aff237c\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"a6a1f64535bb7974\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"81fc8988ec829f23\",\"/knowledge-medium/src/vendor/react-dom.js\":\"888b96ea84407c72\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"4e0e77393193eec8\",\"/knowledge-medium/src/vendor/react.js\":\"f3dc77617038c2c9\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
