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
		buildId: "211e4d3b85a8-bc1e05e8",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/\":\"a6f8a6c13f85327f\",\"/knowledge-medium/index.html\":\"a6f8a6c13f85327f\",\"/knowledge-medium/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/app.css\":\"4158d0feb5da5128\",\"/knowledge-medium/assets/FacadeVFS-DLOcWWwL.js\":\"850f219ddf073864\",\"/knowledge-medium/assets/OPFSCoopSyncVFS-CCl0iEyf.js\":\"ecd1e7572ee8d153\",\"/knowledge-medium/assets/OPFSWriteAheadVFS-Be4CRYBm.js\":\"a633cf7f9b8d8a9a\",\"/knowledge-medium/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/assets/wa-sqlite-KNlBRldZ.js\":\"657c34b1f8f75733\",\"/knowledge-medium/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/assets/wa-sqlite-async-D8QADiBa.js\":\"ca118d8edbdf7811\",\"/knowledge-medium/assets/worker-FAfYH73i.js\":\"324fd1561032e314\",\"/knowledge-medium/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/chunks/app-xoDwVA4C.js\":\"21419dab8f100a4f\",\"/knowledge-medium/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/index.js\":\"70f3d592d5bb2d7e\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/assets/AccessHandlePoolVFS-yWk54ani.js\":\"9ab0e61c1c5c42e4\",\"/knowledge-medium/assets/IDBBatchAtomicVFS-Con1Z1Ef.js\":\"096bef330ba5142a\",\"/knowledge-medium/assets/MemoryVFS-B3TIXXid.js\":\"074188e1e97c44a2\",\"/knowledge-medium/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/assets/mc-wa-sqlite-DqKbAnGG.js\":\"cc703f8a5f1f9947\",\"/knowledge-medium/assets/mc-wa-sqlite-async-DKA_2EoW.js\":\"b98f404ac6ccf353\",\"/knowledge-medium/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/chunks/AccessHandlePoolVFS-DMM4JKlg.js\":\"e3486061efbfa7f1\",\"/knowledge-medium/chunks/FacadeVFS-BwM-zYkH.js\":\"7814b2b8dadf2783\",\"/knowledge-medium/chunks/IDBBatchAtomicVFS-DJYJzqbV.js\":\"05e47ac3733d6a8a\",\"/knowledge-medium/chunks/MemoryVFS-BwtOj9YC.js\":\"b28372f74a508859\",\"/knowledge-medium/chunks/OPFSCoopSyncVFS-B7_LRWGm.js\":\"89791a4be0c3d139\",\"/knowledge-medium/chunks/OPFSWriteAheadVFS-DFc-REHR.js\":\"017d3fb432b279ba\",\"/knowledge-medium/chunks/Preview-Dy0RAGYo.js\":\"fd86641bad089a51\",\"/knowledge-medium/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/chunks/card-BjFksi_v.js\":\"10f497e99b06a552\",\"/knowledge-medium/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/chunks/dist-C_jicFLt.js\":\"dd7ad46783cf0b90\",\"/knowledge-medium/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/chunks/mc-wa-sqlite-BY9KsUUX.js\":\"d6655973cf24c54b\",\"/knowledge-medium/chunks/mc-wa-sqlite-async-BCN4wOwe.js\":\"9771063f74eaf6f7\",\"/knowledge-medium/chunks/react-76K-5re5.js\":\"dafc89f89259e02b\",\"/knowledge-medium/chunks/react-B1KhoPDi.js\":\"27f97e48842a9b2d\",\"/knowledge-medium/chunks/react-Bplfw2b0.js\":\"8253e8e3fdf364f3\",\"/knowledge-medium/chunks/react-C79mylFq.js\":\"e10b80744300f9d9\",\"/knowledge-medium/chunks/react-C8nsPZyU.js\":\"bcfbfe9f4f5960b7\",\"/knowledge-medium/chunks/react-DXk_lVXe.js\":\"94b68c4dcbf9fd40\",\"/knowledge-medium/chunks/react-DxJ7C155.js\":\"db164c659397f5c8\",\"/knowledge-medium/chunks/react-dom-server-legacy.browser.production-B5O91u8j.js\":\"282f11bc53665de9\",\"/knowledge-medium/chunks/react-dom-server.browser.production-CXy1tXY-.js\":\"77fd9dd576d2b439\",\"/knowledge-medium/chunks/react-dom-server.edge.production-CMnCpazJ.js\":\"9c869097de3d8aa9\",\"/knowledge-medium/chunks/react-vAnpGqh8.js\":\"20824c56dfdc1d61\",\"/knowledge-medium/chunks/server.browser-CWh_Ed2W.js\":\"0f28a7677d7c5fda\",\"/knowledge-medium/chunks/textarea-RlwacgfW.js\":\"88eb3d95d0eb370e\",\"/knowledge-medium/chunks/ui-CAELt7Fw.js\":\"33bf63e57f878082\",\"/knowledge-medium/chunks/wa-sqlite-Cwv2Ss0f.js\":\"573e560ca0344c9a\",\"/knowledge-medium/chunks/wa-sqlite-async-G_SXTMEP.js\":\"4da00ac7e3130930\",\"/knowledge-medium/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/extension-utilities.css\":\"d939c4575e1c3411\",\"/knowledge-medium/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/src/App.js\":\"c46589a7f2f2b0c2\",\"/knowledge-medium/src/appUpdate.js\":\"6b03c40202e4d54d\",\"/knowledge-medium/src/appVersion.js\":\"53d07878cf83af1d\",\"/knowledge-medium/src/bootstrap/initialLayout.js\":\"b071b15ee70bc3b1\",\"/knowledge-medium/src/bootstrap/openWorkspaceData.js\":\"8f5fecc1dc5a930f\",\"/knowledge-medium/src/bootstrap/resolveWorkspace.js\":\"5d32ca22b1524e5e\",\"/knowledge-medium/src/bootstrap/workspaceBootstrap.js\":\"db0cd49320ea676d\",\"/knowledge-medium/src/components/BlockComponent.js\":\"9daf191f661707a2\",\"/knowledge-medium/src/components/BlockCrumbs.js\":\"126ef8bc2369eda1\",\"/knowledge-medium/src/components/BlockEditor.js\":\"97280565604f3a1e\",\"/knowledge-medium/src/components/BlockLoadingPlaceholder.js\":\"9842afaa01929486\",\"/knowledge-medium/src/components/BlockProperties.js\":\"39844fc5d4e78d40\",\"/knowledge-medium/src/components/BlockSearchPicker.js\":\"f64a352020a936cc\",\"/knowledge-medium/src/components/ConfirmBulkDeleteDialog.js\":\"dc03b8ae9103c775\",\"/knowledge-medium/src/components/DividerHandle.js\":\"c92c63ef71396e07\",\"/knowledge-medium/src/components/DraftEditor.js\":\"45d5822a62f90ace\",\"/knowledge-medium/src/components/GutterPill.js\":\"da44e632d8bf1c00\",\"/knowledge-medium/src/components/Header.js\":\"29fefcd1f591c9ed\",\"/knowledge-medium/src/components/LazyBlockComponent.js\":\"06e3d3538ada420f\",\"/knowledge-medium/src/components/Login.js\":\"c1ba18a5e1aa74d0\",\"/knowledge-medium/src/components/ZoomableSurface.js\":\"4d2b94eb4fde50bf\",\"/knowledge-medium/src/components/editModeKeepalive.js\":\"0ec9b83995b4223f\",\"/knowledge-medium/src/components/propertyDisplay/PropertyDisplayScope.js\":\"19b0ffd03efee909\",\"/knowledge-medium/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"3b2aa7c854e1c650\",\"/knowledge-medium/src/components/propertyEditors/RefPropertyEditor.js\":\"6b64d9d652015ef3\",\"/knowledge-medium/src/components/propertyEditors/RefTargetTypePicker.js\":\"51408ece265badcd\",\"/knowledge-medium/src/components/propertyEditors/SelectPropertyEditor.js\":\"f042003eaa674fb3\",\"/knowledge-medium/src/components/propertyEditors/TypesPropertyEditor.js\":\"e95955a55711cbe2\",\"/knowledge-medium/src/components/propertyEditors/defaults.js\":\"da49c009239178f8\",\"/knowledge-medium/src/components/propertyEditors/kernelValuePresets.js\":\"bba858134f05140a\",\"/knowledge-medium/src/components/propertyEditors/selectablePresets.js\":\"46b65fbbe5f58f5f\",\"/knowledge-medium/src/components/propertyEditors/typesPropertyUi.js\":\"6b7d277f6da8a459\",\"/knowledge-medium/src/components/propertyPanel/AddPropertyForm.js\":\"d039ea1ee5158d22\",\"/knowledge-medium/src/components/propertyPanel/PropertyPicker.js\":\"b9fd89b0c7530eba\",\"/knowledge-medium/src/components/propertyPanel/PropertyRow.js\":\"9d7b2d71642c44ba\",\"/knowledge-medium/src/components/propertyPanel/Rows.js\":\"d267c3915fa35971\",\"/knowledge-medium/src/components/propertyPanel/actions.js\":\"583ee6672e4ca90e\",\"/knowledge-medium/src/components/propertyPanel/declarationOnly.js\":\"0beee71f73d204f3\",\"/knowledge-medium/src/components/propertyPanel/layout.js\":\"cfa361444feb1711\",\"/knowledge-medium/src/components/propertyPanel/model.js\":\"df97139266951d4f\",\"/knowledge-medium/src/components/propertyPanel/shapeUi.js\":\"6e08cc0edcf7b73e\",\"/knowledge-medium/src/components/propertyPanel/shapes.js\":\"9d3d227a1ba8e1c9\",\"/knowledge-medium/src/components/propertyPanel/usePropertyEditingActivation.js\":\"c0abbfc987795c65\",\"/knowledge-medium/src/components/propertyPanel/visibility.js\":\"5b9d9da739db61b7\",\"/knowledge-medium/src/components/propertyPanelSections.js\":\"3bc8fad69015e0c4\",\"/knowledge-medium/src/components/references/BlockEmbed.js\":\"7d89666cd2bbe352\",\"/knowledge-medium/src/components/references/BlockLink.js\":\"94ae12e4758ac09a\",\"/knowledge-medium/src/components/references/BlockRef.js\":\"33bd3ad7775c0cc3\",\"/knowledge-medium/src/components/references/ReferenceLink.js\":\"cef8968a7cc2e184\",\"/knowledge-medium/src/components/references/cycleGuard.js\":\"14511e1653914177\",\"/knowledge-medium/src/components/references/cycleGuardContext.js\":\"51f99cdb05b08e50\",\"/knowledge-medium/src/components/references/linkInteraction.js\":\"7ffbfa52a404e2ed\",\"/knowledge-medium/src/components/references/referenceLayout.js\":\"cd8ecf69709ca7fe\",\"/knowledge-medium/src/components/references/useBlockRefAncestors.js\":\"45f894e675b97c87\",\"/knowledge-medium/src/components/renderer/BlockGutter.js\":\"15f9f42470616425\",\"/knowledge-medium/src/components/renderer/BlockInfoDialog.js\":\"25aabbaa7168b511\",\"/knowledge-medium/src/components/renderer/BlockTypeBlockRenderer.js\":\"16390387e4c6c164\",\"/knowledge-medium/src/components/renderer/BulletHoverCard.js\":\"83fd0a9ff6662901\",\"/knowledge-medium/src/components/renderer/CodeMirrorContentRenderer.js\":\"858da87156d6271b\",\"/knowledge-medium/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"ffd7892d2ce55471\",\"/knowledge-medium/src/components/renderer/ColumnResizeHandles.js\":\"c2d56d1079b6bc1e\",\"/knowledge-medium/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"f9e52609873f9a48\",\"/knowledge-medium/src/components/renderer/DefaultBlockRenderer.js\":\"84da1c45dbd12c72\",\"/knowledge-medium/src/components/renderer/LayoutRenderer.js\":\"c0c3e8ec56997bae\",\"/knowledge-medium/src/components/renderer/MarkdownContentRenderer.js\":\"b838665488d341f9\",\"/knowledge-medium/src/components/renderer/MissingDataRenderer.js\":\"4a3c1e0b037051a3\",\"/knowledge-medium/src/components/renderer/PanelRenderer.js\":\"a3067a66e6957ec8\",\"/knowledge-medium/src/components/renderer/PropertySchemaBlockRenderer.js\":\"2ac9f912c6bf1282\",\"/knowledge-medium/src/components/renderer/TopLevelRenderer.js\":\"2998876f7d6bd586\",\"/knowledge-medium/src/components/renderer/blockGutterMode.js\":\"c30583e631c5456a\",\"/knowledge-medium/src/components/renderer/blockTitleText.js\":\"250100c4518b8cd8\",\"/knowledge-medium/src/components/renderer/fieldCreationKeydown.js\":\"40f6fc1bbaae5dc2\",\"/knowledge-medium/src/components/renderer/layoutRootContext.js\":\"5735e3bcbfb21c35\",\"/knowledge-medium/src/components/typeChip/TypeChip.js\":\"fd2c1a14b2b7250e\",\"/knowledge-medium/src/components/typeChip/chipStyle.js\":\"02a4ddbc63d18c99\",\"/knowledge-medium/src/components/ui/anchored-floating.js\":\"287a53a6041564a6\",\"/knowledge-medium/src/components/ui/button.js\":\"5b7b93c45213f2f5\",\"/knowledge-medium/src/components/ui/card.js\":\"224644fc0516fab0\",\"/knowledge-medium/src/components/ui/checkbox.js\":\"b1af2802a537f0de\",\"/knowledge-medium/src/components/ui/collapsible.js\":\"2630375d5e8040cd\",\"/knowledge-medium/src/components/ui/command.js\":\"2458d5852cbb9731\",\"/knowledge-medium/src/components/ui/context-menu.js\":\"67bb141a00046dd2\",\"/knowledge-medium/src/components/ui/dialog.js\":\"ad6871d40ca6588a\",\"/knowledge-medium/src/components/ui/dropdown-menu.js\":\"f7279282e51bd488\",\"/knowledge-medium/src/components/ui/floating-listbox.js\":\"1d61cce42e342e97\",\"/knowledge-medium/src/components/ui/index.js\":\"fbe469ccdfcabf20\",\"/knowledge-medium/src/components/ui/input.js\":\"77cd0953e9bb8c74\",\"/knowledge-medium/src/components/ui/kbd.js\":\"246613b84ec49547\",\"/knowledge-medium/src/components/ui/label.js\":\"3b77adbcb032c0f4\",\"/knowledge-medium/src/components/ui/textarea.js\":\"531810497558a839\",\"/knowledge-medium/src/components/useEditModeYieldKeepalive.js\":\"eeac2cf4ff305c87\",\"/knowledge-medium/src/components/util/BootFallback.js\":\"f262028f1f632b23\",\"/knowledge-medium/src/components/util/FocusedRowLazyMount.js\":\"e1fff983727fef4f\",\"/knowledge-medium/src/components/util/LazyViewportMount.js\":\"01f755062899fe8f\",\"/knowledge-medium/src/components/util/LocalDbCorruptionFallback.js\":\"d7451800459182d5\",\"/knowledge-medium/src/components/util/error.js\":\"f12dff6564d03ffd\",\"/knowledge-medium/src/components/util/lazyMountRegistry.js\":\"16bb469bcd419739\",\"/knowledge-medium/src/components/util/suspense.js\":\"fce8de22792c9b1b\",\"/knowledge-medium/src/components/workspace/CreateWorkspaceDialog.js\":\"5ddc9a9d6ccc9342\",\"/knowledge-medium/src/components/workspace/PendingInvitations.js\":\"04cd0bf766c8124e\",\"/knowledge-medium/src/components/workspace/SyncProgress.js\":\"6a6ca0a5197f0066\",\"/knowledge-medium/src/components/workspace/UnlockProgress.js\":\"360db4e24ba92eba\",\"/knowledge-medium/src/components/workspace/WorkspaceKeyGate.js\":\"a3b20469f36fe6d7\",\"/knowledge-medium/src/components/workspace/WorkspaceSettingsDialog.js\":\"102ca1dc3dc8591b\",\"/knowledge-medium/src/components/workspace/WorkspaceSwitcher.js\":\"0b312cced6cf8295\",\"/knowledge-medium/src/components/workspace/WorkspaceSyncGate.js\":\"b4b9a879e6a0e296\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlow.js\":\"bff98868d846c6f3\",\"/knowledge-medium/src/components/workspace/conversion/ConversionFlowHost.js\":\"8c3b38dde9a177a0\",\"/knowledge-medium/src/components/workspace/conversion/EncryptionSection.js\":\"06fa5e2c981f75a5\",\"/knowledge-medium/src/components/workspace/conversion/attachmentPrompts.js\":\"0fb9843a2d2f78e9\",\"/knowledge-medium/src/components/workspace/conversion/bundleFolderPrompts.js\":\"a097364c21a8c745\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowDeps.js\":\"26ed959598554367\",\"/knowledge-medium/src/components/workspace/conversion/conversionFlowStore.js\":\"4d71257ea83965ae\",\"/knowledge-medium/src/components/workspace/conversion/flowUi.js\":\"57579c517b919d49\",\"/knowledge-medium/src/components/workspace/conversion/useConversionRun.js\":\"b6e674d94c3a6f2b\",\"/knowledge-medium/src/components/workspace/keyUi.js\":\"7ba38b8464947ea6\",\"/knowledge-medium/src/components/workspace/useCloseOnKeyLoss.js\":\"9213b8ada6e58628\",\"/knowledge-medium/src/components/workspace/useCloseOnServerE2ee.js\":\"4894cbf9ea78702d\",\"/knowledge-medium/src/components/workspace/workspaceUnlocked.js\":\"d115897fdadd711d\",\"/knowledge-medium/src/context/backgroundSubtree.js\":\"ff0f1155a86f2069\",\"/knowledge-medium/src/context/block.js\":\"e5d36d7986d22856\",\"/knowledge-medium/src/context/layoutWsContext.js\":\"533867f88feb21bf\",\"/knowledge-medium/src/context/propertyDisplay.js\":\"9549f1c460486a85\",\"/knowledge-medium/src/context/repo.js\":\"b7cd1d3ceca56872\",\"/knowledge-medium/src/data/aliasClaim.js\":\"3e96ac33cf5e28a9\",\"/knowledge-medium/src/data/aliasSeatNamespace.js\":\"3f79fe0ff269b4c0\",\"/knowledge-medium/src/data/api/blockData.js\":\"f7e57907c30018d6\",\"/knowledge-medium/src/data/api/blockType.js\":\"4945f657726a4f01\",\"/knowledge-medium/src/data/api/changeScope.js\":\"0b46cdaa4a5b8ba4\",\"/knowledge-medium/src/data/api/codecs.js\":\"7a23506a2a412ac9\",\"/knowledge-medium/src/data/api/derivedData.js\":\"5da0dd9dd94924e1\",\"/knowledge-medium/src/data/api/errors.js\":\"60a6f555044a7444\",\"/knowledge-medium/src/data/api/events.js\":\"33fcb41a095b5437\",\"/knowledge-medium/src/data/api/handle.js\":\"305cf86762bedb39\",\"/knowledge-medium/src/data/api/index.js\":\"dd0a0a7d14c472b2\",\"/knowledge-medium/src/data/api/mutator.js\":\"ec6c161490666187\",\"/knowledge-medium/src/data/api/processor.js\":\"3a988110304c8db7\",\"/knowledge-medium/src/data/api/propertySchema.js\":\"1a12c86406316034\",\"/knowledge-medium/src/data/api/query.js\":\"7c8e01cdc878f722\",\"/knowledge-medium/src/data/api/sameTxProcessor.js\":\"22ff0277e02201ee\",\"/knowledge-medium/src/data/api/schema.js\":\"305cf86762bedb39\",\"/knowledge-medium/src/data/api/tx.js\":\"305cf86762bedb39\",\"/knowledge-medium/src/data/api/typedBlockQuery.js\":\"6086d173a548bc19\",\"/knowledge-medium/src/data/api/user.js\":\"71e862652ea626ff\",\"/knowledge-medium/src/data/api/valuePresetCore.js\":\"22d1517b1732c77d\",\"/knowledge-medium/src/data/api/valuePresets.js\":\"e860b52265866140\",\"/knowledge-medium/src/data/attachmentCleanerIOVerb.js\":\"9593f8a213298758\",\"/knowledge-medium/src/data/block.js\":\"42d7daf3c685f8bf\",\"/knowledge-medium/src/data/blockCache.js\":\"5d4b8f8acd06942b\",\"/knowledge-medium/src/data/blockId.js\":\"28b170fe2811d5b2\",\"/knowledge-medium/src/data/blockLiveness.js\":\"d35085f0acbb96da\",\"/knowledge-medium/src/data/blockMerge.js\":\"5da55f42070aa192\",\"/knowledge-medium/src/data/blockSchema.js\":\"1ca9ccfa0edb652f\",\"/knowledge-medium/src/data/blockTypeLookup.js\":\"ab0ad1bb42dabc7e\",\"/knowledge-medium/src/data/blockTypes.js\":\"29ce0589d85a9436\",\"/knowledge-medium/src/data/childrenView.js\":\"9e41b78e5921f6ae\",\"/knowledge-medium/src/data/clientContext.js\":\"cbd19aba69bc07a4\",\"/knowledge-medium/src/data/dbFileSiblings.js\":\"7b2b91ac4ba2f532\",\"/knowledge-medium/src/data/definitionSeeds.js\":\"6df103dba76cf802\",\"/knowledge-medium/src/data/derivedIds.js\":\"7db85fbf6bc811c4\",\"/knowledge-medium/src/data/drawnSubtree.js\":\"b5bade154784efcd\",\"/knowledge-medium/src/data/facetBridge.js\":\"a3dfdedff8ef09ca\",\"/knowledge-medium/src/data/facets.js\":\"10118ddd45b7a3e6\",\"/knowledge-medium/src/data/globalState.js\":\"878440398301111a\",\"/knowledge-medium/src/data/internals/aliasClaimRederiveProcessor.js\":\"1801261410f5d280\",\"/knowledge-medium/src/data/internals/ancestorBatch.js\":\"14fcf91819a9e3dc\",\"/knowledge-medium/src/data/internals/blockTypeTypeifyProcessor.js\":\"3b69835424378c3f\",\"/knowledge-medium/src/data/internals/clientSchema.js\":\"e930a621e58a17b8\",\"/knowledge-medium/src/data/internals/commitPipeline.js\":\"8c8b7f8079f3c80a\",\"/knowledge-medium/src/data/internals/devAssertions.js\":\"b087a902e1dbfd35\",\"/knowledge-medium/src/data/internals/firstSync.js\":\"75ffb4954a25da7e\",\"/knowledge-medium/src/data/internals/freshInitialLoad.js\":\"8e270789a3514d66\",\"/knowledge-medium/src/data/internals/graphBackfillClaim.js\":\"4fe2199f917a4ef5\",\"/knowledge-medium/src/data/internals/handleStore.js\":\"88b9de995a69e482\",\"/knowledge-medium/src/data/internals/idleMarkerJobs.js\":\"e724343e9671ed78\",\"/knowledge-medium/src/data/internals/initialDownload.js\":\"07f7ea171a328a8f\",\"/knowledge-medium/src/data/internals/initializeClientDatabase.js\":\"5e858f7d62887054\",\"/knowledge-medium/src/data/internals/jsonCanonical.js\":\"1f71f8f81f8c610d\",\"/knowledge-medium/src/data/internals/kernelInvalidation.js\":\"90292de8ed8f8978\",\"/knowledge-medium/src/data/internals/kernelProcessors.js\":\"41678d5408298f3c\",\"/knowledge-medium/src/data/internals/kernelQueries.js\":\"3b6e5e5ec8681916\",\"/knowledge-medium/src/data/internals/mergeTypeMembershipProcessor.js\":\"9973878866f1d3c4\",\"/knowledge-medium/src/data/internals/normalizeReferencesProcessor.js\":\"a63e5bb00a2118ef\",\"/knowledge-medium/src/data/internals/poolInstrumentation.js\":\"4e7d8c563ed72690\",\"/knowledge-medium/src/data/internals/processorRunner.js\":\"c58aa2ac1e28ac0f\",\"/knowledge-medium/src/data/internals/propertyCellBackfill.js\":\"c783d6497c856690\",\"/knowledge-medium/src/data/internals/propertyChildMint.js\":\"14a23ad827ca2da4\",\"/knowledge-medium/src/data/internals/propertyChildrenProcessor.js\":\"54ad9055718a3cb0\",\"/knowledge-medium/src/data/internals/propertyDefinitionChangeProcessor.js\":\"9a029c65c984ea66\",\"/knowledge-medium/src/data/internals/propertyDefinitionSynthesis.js\":\"f3c7e7209db4d429\",\"/knowledge-medium/src/data/internals/propertyKeyScan.js\":\"738fe273a9a1d3a8\",\"/knowledge-medium/src/data/internals/propertySchemaResolution.js\":\"7154ff2a8f80c530\",\"/knowledge-medium/src/data/internals/propertyValueEdits.js\":\"bf8f4896ad5f4fb1\",\"/knowledge-medium/src/data/internals/raiseProtocol.js\":\"8b3ec2a1ffe382db\",\"/knowledge-medium/src/data/internals/readBatch.js\":\"e6a43baf6e2106a1\",\"/knowledge-medium/src/data/internals/refProjection.js\":\"95715c44f1041934\",\"/knowledge-medium/src/data/internals/referenceTargetLookups.js\":\"6f03e5b6c4e01183\",\"/knowledge-medium/src/data/internals/referenceTargetProcessor.js\":\"26e6fbd641ab8731\",\"/knowledge-medium/src/data/internals/replayMerge.js\":\"a5e1df54b858eafa\",\"/knowledge-medium/src/data/internals/sqlBinds.js\":\"de4239268149fcaf\",\"/knowledge-medium/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"b01be1b3b73b1ffd\",\"/knowledge-medium/src/data/internals/syncObserver/arrivalProcessors.js\":\"68321467ae37935f\",\"/knowledge-medium/src/data/internals/syncObserver/invalidate.js\":\"70f3bf93fee72316\",\"/knowledge-medium/src/data/internals/syncObserver/materialize.js\":\"21012113a95e26c6\",\"/knowledge-medium/src/data/internals/syncObserver/observer.js\":\"6fcd483e341de586\",\"/knowledge-medium/src/data/internals/syncObserver/reconcile.js\":\"5728425577b2ac38\",\"/knowledge-medium/src/data/internals/timingMetrics.js\":\"4c1c20b2560929a6\",\"/knowledge-medium/src/data/internals/treeQueries.js\":\"ada12eb94377499b\",\"/knowledge-medium/src/data/internals/txEngine.js\":\"1f0a00fba2882115\",\"/knowledge-medium/src/data/internals/txSnapshots.js\":\"c69fe18af7919a05\",\"/knowledge-medium/src/data/internals/typedBlockQuery.js\":\"e179b9863d3acc15\",\"/knowledge-medium/src/data/internals/undoManager.js\":\"b27dec658052b580\",\"/knowledge-medium/src/data/invalidation.js\":\"94d63b4cec1c1754\",\"/knowledge-medium/src/data/kernelDataExtension.js\":\"b71e290a7d8fef87\",\"/knowledge-medium/src/data/kernelPage.js\":\"86259179414d2ee0\",\"/knowledge-medium/src/data/kernelValuePresetCores.js\":\"d4da20750f34a513\",\"/knowledge-medium/src/data/localDbCorruptionSignal.js\":\"e96a952151392795\",\"/knowledge-medium/src/data/localDbStorage.js\":\"815d08302cbb9aa7\",\"/knowledge-medium/src/data/localDbVfs.js\":\"2a93222641062257\",\"/knowledge-medium/src/data/localSchema.js\":\"5669ba8643edfc3e\",\"/knowledge-medium/src/data/maintenance.js\":\"05c7cea641a6eda8\",\"/knowledge-medium/src/data/mergeProperties.js\":\"2c457b9e2a8c4e26\",\"/knowledge-medium/src/data/metricsConsoleHook.js\":\"3f6417f56f81b80b\",\"/knowledge-medium/src/data/migrationsPage.js\":\"1fc8d47268e42900\",\"/knowledge-medium/src/data/mutators.js\":\"42479e32a2023dce\",\"/knowledge-medium/src/data/orderKey.js\":\"6a0b90170071f900\",\"/knowledge-medium/src/data/orderKeyPlacement.js\":\"936f6e75b1f17d5f\",\"/knowledge-medium/src/data/outlineSurface.js\":\"3b14f5065d4acd23\",\"/knowledge-medium/src/data/pendingEditorContent.js\":\"ec47091532a8970d\",\"/knowledge-medium/src/data/pendingUploadsSql.js\":\"8094e1c7b06a84c8\",\"/knowledge-medium/src/data/pluginStateExtensions.js\":\"9f721a1d69888732\",\"/knowledge-medium/src/data/powerSyncLogger.js\":\"a5de6367ae910d37\",\"/knowledge-medium/src/data/projectorRuntime.js\":\"091baa2559ec7f60\",\"/knowledge-medium/src/data/properties.js\":\"2bd96f7fb668516b\",\"/knowledge-medium/src/data/propertiesPage.js\":\"0788f6bf1740f67c\",\"/knowledge-medium/src/data/propertyChildren.js\":\"0c077f8f3185521b\",\"/knowledge-medium/src/data/propertyDefinitionFanout.js\":\"8c978e3a1d557ccf\",\"/knowledge-medium/src/data/propertyDefinitionMetadata.js\":\"f3d278c99a518d51\",\"/knowledge-medium/src/data/propertyDefinitionRegistry.js\":\"5917e2a19becbaa1\",\"/knowledge-medium/src/data/propertyDisplayMode.js\":\"d2933b8dc789b0af\",\"/knowledge-medium/src/data/propertyRowCreation.js\":\"677f66bf2c28a42c\",\"/knowledge-medium/src/data/propertySchemaCreation.js\":\"0ca9163fc53d7827\",\"/knowledge-medium/src/data/propertySeeds.js\":\"a2fc1a20b6b16722\",\"/knowledge-medium/src/data/recentsPage.js\":\"92caeaab3d966c50\",\"/knowledge-medium/src/data/refTargetComparableProperty.js\":\"6d7150dfb0088a4c\",\"/knowledge-medium/src/data/referenceBlock.js\":\"d7a18b99917cde8e\",\"/knowledge-medium/src/data/rejectedUploads.js\":\"4c480d5ba1f495ec\",\"/knowledge-medium/src/data/releasePowerSyncConnection.js\":\"1cc6b20a61ace456\",\"/knowledge-medium/src/data/repo.js\":\"a81d604c097b3830\",\"/knowledge-medium/src/data/repoProvider.js\":\"03769616a39cf0f2\",\"/knowledge-medium/src/data/rowProperty.js\":\"f25f228a0035f084\",\"/knowledge-medium/src/data/searchFilter.js\":\"9e1b818dafe5d089\",\"/knowledge-medium/src/data/seedIdentityLedger.js\":\"4cf2edf09dadf679\",\"/knowledge-medium/src/data/stateBlocks.js\":\"2a9f9b2d7208c0c0\",\"/knowledge-medium/src/data/structuralEditPolicy.js\":\"c9530d6b532294de\",\"/knowledge-medium/src/data/structuralInsert.js\":\"188b7765d56bf01e\",\"/knowledge-medium/src/data/subtreeDelete.js\":\"ded4c2ba14d3e7b1\",\"/knowledge-medium/src/data/syncStreamLock.js\":\"f441f7fd74e041af\",\"/knowledge-medium/src/data/syncedTableSqlRecognizer.js\":\"8ee1e28198392752\",\"/knowledge-medium/src/data/syncedTableWriteGuard.js\":\"97eae52b89457b1d\",\"/knowledge-medium/src/data/targets.js\":\"37c29bcc12e9d7c5\",\"/knowledge-medium/src/data/typeColors.js\":\"f73dea013b9331c5\",\"/knowledge-medium/src/data/typeDefinitionMetadata.js\":\"5f9dd5107bd3c423\",\"/knowledge-medium/src/data/typeDefinitionRegistry.js\":\"0f2c2336434dc8f2\",\"/knowledge-medium/src/data/typeExtraction.js\":\"df84addd1c754fdc\",\"/knowledge-medium/src/data/typeInitialValues.js\":\"65b52b20caca0d9d\",\"/knowledge-medium/src/data/typePropertyGroups.js\":\"5d33b61118deaf10\",\"/knowledge-medium/src/data/typeSeeds.js\":\"ed621cb10e3dfe5f\",\"/knowledge-medium/src/data/typeTagger.js\":\"a1b9d749e7482eab\",\"/knowledge-medium/src/data/typedRecords.js\":\"69480e2192279777\",\"/knowledge-medium/src/data/typesPage.js\":\"5487a922e8ddff3c\",\"/knowledge-medium/src/data/userPrefs.js\":\"651611e99496bc9c\",\"/knowledge-medium/src/data/userSchemasService.js\":\"bc7e8a4ee3cadff3\",\"/knowledge-medium/src/data/userTypesService.js\":\"db892a8b62a68afb\",\"/knowledge-medium/src/data/valuePresetRegistry.js\":\"8a8da994d1f91ded\",\"/knowledge-medium/src/data/visibleChildren.js\":\"136862bec6b91f26\",\"/knowledge-medium/src/data/workspaceConversion.js\":\"f1845f2af2ccd86d\",\"/knowledge-medium/src/data/workspaceFirstSync.js\":\"eef70ad2e693aa5f\",\"/knowledge-medium/src/data/workspaceIdNamespace.js\":\"10ad39adf88ef03e\",\"/knowledge-medium/src/data/workspaceSchema.js\":\"2f6319cec1308e73\",\"/knowledge-medium/src/data/workspaces.js\":\"0fffd3f77d3b307f\",\"/knowledge-medium/src/data/writeAheadLog.js\":\"3feae1609c184b81\",\"/knowledge-medium/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/src/editor/BlockPasteShellDecorator.js\":\"5be2482d41b29999\",\"/knowledge-medium/src/editor/atTrigger.js\":\"a317ab94fb966794\",\"/knowledge-medium/src/editor/autocomplete.js\":\"2183e07612d1a44f\",\"/knowledge-medium/src/editor/codeMirrorExtensions.js\":\"7843903c4891a6ad\",\"/knowledge-medium/src/editor/contentFlush.js\":\"8c703636ae5ea354\",\"/knowledge-medium/src/editor/defaultInteractions.js\":\"909fddb32d6bcf29\",\"/knowledge-medium/src/editor/editSettleSignal.js\":\"1004b1015145d795\",\"/knowledge-medium/src/editor/insertImage.js\":\"440fb1dafa6c33a0\",\"/knowledge-medium/src/editor/referenceCompletionRange.js\":\"cdfb6930c4301d0f\",\"/knowledge-medium/src/editor/referenceTargetTypes.js\":\"7bd28bad75c0afa2\",\"/knowledge-medium/src/editor/syntaxContext.js\":\"b4ff692618ba494e\",\"/knowledge-medium/src/editor/triggerMatch.js\":\"eedc98f825796a88\",\"/knowledge-medium/src/extensions/AppRuntimeProvider.js\":\"3bc7df5b41222a6d\",\"/knowledge-medium/src/extensions/BlockFocusShellDecorator.js\":\"7dfe8c0d1bc81ef7\",\"/knowledge-medium/src/extensions/ExtensionRenderBoundary.js\":\"9254d655d0437cbd\",\"/knowledge-medium/src/extensions/PanelContentRecovery.js\":\"fb8b52f0471d89e7\",\"/knowledge-medium/src/extensions/apiCatalog.js\":\"84c57d7e2d5206c3\",\"/knowledge-medium/src/extensions/approveExtensionHere.js\":\"ae9f291236c8bf37\",\"/knowledge-medium/src/extensions/armedCutAppMount.js\":\"b4091165d91f2aef\",\"/knowledge-medium/src/extensions/batchableKeyedStore.js\":\"35b0f1b8cc2756d9\",\"/knowledge-medium/src/extensions/blockInteraction.js\":\"3581e1ed6a07953c\",\"/knowledge-medium/src/extensions/blockSelectionAction.js\":\"09ebbe24b5d78785\",\"/knowledge-medium/src/extensions/compileExtensionModule.js\":\"7e9f40579e72dd47\",\"/knowledge-medium/src/extensions/compiledModuleCache.js\":\"097bd96bef4fb464\",\"/knowledge-medium/src/extensions/continuousGestures.js\":\"67cc371a6f2fd04a\",\"/knowledge-medium/src/extensions/core.js\":\"b126a1ce3be37a41\",\"/knowledge-medium/src/extensions/defaultRenderers.js\":\"ed5b079cd8fe5a56\",\"/knowledge-medium/src/extensions/definitionFanoutAppMount.js\":\"5325c047b5a66990\",\"/knowledge-medium/src/extensions/dialogAppMount.js\":\"77177289d81f6ddf\",\"/knowledge-medium/src/extensions/dynamicExtensionSeeds.js\":\"1b1a6a2f176809b4\",\"/knowledge-medium/src/extensions/dynamicExtensions.js\":\"5791d3d9952f4aa4\",\"/knowledge-medium/src/extensions/exampleExtensions.js\":\"1fadd2fa63c80af7\",\"/knowledge-medium/src/extensions/extensionApprovalStatus.js\":\"584e311e9ba27668\",\"/knowledge-medium/src/extensions/extensionLoadErrorToast.js\":\"ee9455490d244bb4\",\"/knowledge-medium/src/extensions/extensionLoadErrors.js\":\"da6188bed4bd3000\",\"/knowledge-medium/src/extensions/extensionLookup.js\":\"e8f9b8afed1ccd0c\",\"/knowledge-medium/src/extensions/extensionToggles.js\":\"ca15d77f75375054\",\"/knowledge-medium/src/extensions/extensionUtilitiesCss.js\":\"49354833790b4287\",\"/knowledge-medium/src/extensions/kernelPageDeletionGuard.js\":\"6f38d02aee56649d\",\"/knowledge-medium/src/extensions/liveRuntime.js\":\"7a3d5c5af8b55439\",\"/knowledge-medium/src/extensions/openExtensionsSettings.js\":\"12fc6bb51772f2fc\",\"/knowledge-medium/src/extensions/overridesCache.js\":\"d0b5cf0bdc7203f2\",\"/knowledge-medium/src/extensions/pluginIds.js\":\"91adfda62028787c\",\"/knowledge-medium/src/extensions/processorRejectionToast.js\":\"f6c8d6ebf379b0d2\",\"/knowledge-medium/src/extensions/runtimeActions.js\":\"3abbbb248daf0507\",\"/knowledge-medium/src/extensions/runtimeContext.js\":\"ec4dd6c762d69867\",\"/knowledge-medium/src/extensions/staticAppExtensions.js\":\"3af8f4bb86a458bc\",\"/knowledge-medium/src/extensions/staticDataExtensions.js\":\"b23ff7df1d7909d2\",\"/knowledge-medium/src/extensions/toastAppMount.js\":\"b670107dccc9878a\",\"/knowledge-medium/src/extensions/useOverrides.js\":\"497958680e387348\",\"/knowledge-medium/src/extensions/useShortcutSurfaceActivations.js\":\"a835807d704766dd\",\"/knowledge-medium/src/facets/discoverToggleTree.js\":\"2024beb7e3806a3a\",\"/knowledge-medium/src/facets/facet.js\":\"fc674077bfe7e11e\",\"/knowledge-medium/src/facets/resolveAppRuntime.js\":\"26004f1bca4d745d\",\"/knowledge-medium/src/facets/runtimeEvents.js\":\"660843dafba7c694\",\"/knowledge-medium/src/facets/togglable.js\":\"e899e4af3ce871d7\",\"/knowledge-medium/src/facets/variantFacet.js\":\"bbd16e08726cf327\",\"/knowledge-medium/src/facets/verbFacet.js\":\"b124d3b2021be0c3\",\"/knowledge-medium/src/hooks/block.js\":\"a1007e58fcfea635\",\"/knowledge-medium/src/hooks/focusedChild.js\":\"1ad9ccc51446984a\",\"/knowledge-medium/src/hooks/propertySchemas.js\":\"96c880f131e592ce\",\"/knowledge-medium/src/hooks/typeRegistry.js\":\"10e13de957c8281e\",\"/knowledge-medium/src/hooks/useAncestorCrumbs.js\":\"1afef2e14bc0735f\",\"/knowledge-medium/src/hooks/useAutocompleteListbox.js\":\"e808399fb3f8c7f0\",\"/knowledge-medium/src/hooks/useDebouncedSearch.js\":\"886a100f35557269\",\"/knowledge-medium/src/hooks/useDebouncedValue.js\":\"20b800681fdc7a11\",\"/knowledge-medium/src/hooks/useFacetValue.js\":\"77ad53913bdf8ef1\",\"/knowledge-medium/src/hooks/useIsFocalRender.js\":\"a786db06e8446994\",\"/knowledge-medium/src/hooks/useIsReadOnly.js\":\"2b5021be505fb945\",\"/knowledge-medium/src/hooks/useMaterializeBacklog.js\":\"5470392738816b49\",\"/knowledge-medium/src/hooks/useMinuteClock.js\":\"7d809ae464a7e965\",\"/knowledge-medium/src/hooks/usePanelLayoutProjection.js\":\"d198ecc1f057574f\",\"/knowledge-medium/src/hooks/usePendingInvitations.js\":\"3496ecab9677a11f\",\"/knowledge-medium/src/hooks/useRendererRegistry.js\":\"9f104c25b5080313\",\"/knowledge-medium/src/hooks/useRetainedFieldRows.js\":\"b0a0160123ee3a47\",\"/knowledge-medium/src/hooks/useWorkspaces.js\":\"1aa89908dde80c5c\",\"/knowledge-medium/src/lib/utils.js\":\"0b9b3311b45032a8\",\"/knowledge-medium/src/main.js\":\"3b6a9e11b059eda8\",\"/knowledge-medium/src/markdown/MarkdownImage.js\":\"b266fc3bfafc7cbb\",\"/knowledge-medium/src/markdown/blockSeparators.js\":\"f59a085a565a7aaa\",\"/knowledge-medium/src/markdown/context.js\":\"1f1c86168a797b50\",\"/knowledge-medium/src/markdown/defaultMarkdownExtension.js\":\"42dc57fdb2adeeda\",\"/knowledge-medium/src/markdown/extensions.js\":\"e38faafdb85143a3\",\"/knowledge-medium/src/markdown/renderMarkdownHtml.js\":\"ffc107356983e5f5\",\"/knowledge-medium/src/minimal-editor.js\":\"3ff908c701d6906e\",\"/knowledge-medium/src/paste/armedCut.js\":\"a46a06b6d30f1d56\",\"/knowledge-medium/src/paste/captureMediaVerb.js\":\"2a2966c23977a3b8\",\"/knowledge-medium/src/paste/clipboard.js\":\"50cb95e28d3f2f39\",\"/knowledge-medium/src/paste/decision.js\":\"4bd5b14b8ad0b5df\",\"/knowledge-medium/src/paste/operations.js\":\"90a9ebfa7a9db4e9\",\"/knowledge-medium/src/plugins/account-header/AccountHeaderItem.js\":\"9ee3a582baf08ded\",\"/knowledge-medium/src/plugins/account-header/index.js\":\"c0b4f67290062cbd\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"7b3ea04494731363\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askAgent.js\":\"0a7073189f3629ac\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/askedStore.js\":\"cfe70168c5edef78\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"49c443f238aa21df\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/chipState.js\":\"18bea8b1d5abbcd3\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/dataExtension.js\":\"f694c83ba2800580\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/index.js\":\"73f8e244b016c4dd\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"67f9a0d6ade044e1\",\"/knowledge-medium/src/plugins/agent-dispatch-companion/schema.js\":\"6ec9fe6b0e273b69\",\"/knowledge-medium/src/plugins/agent-runtime/AgentTokensDialog.js\":\"ae9ac0238ab3614e\",\"/knowledge-medium/src/plugins/agent-runtime/BridgePairingDialog.js\":\"3ef07ab9e4e73df0\",\"/knowledge-medium/src/plugins/agent-runtime/addMedia.js\":\"42dd4031232f41f6\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/backlinks.js\":\"628f0f4b9d13aea4\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/block.js\":\"0a768e62cd9c0cb3\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/context.js\":\"6cf9c825f3e02aad\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/displayIds.js\":\"b59d502d73836d02\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/index.js\":\"6f80854a3e6969bb\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/outline.js\":\"e27e0a157577f62e\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/properties.js\":\"6e78939aad081c92\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/refs.js\":\"df729e0443335f22\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"867dca2671f30bbd\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/search.js\":\"9e06e3a8b70bca73\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/shared.js\":\"0aa860ea79d3794c\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"a23e459cdac0d229\",\"/knowledge-medium/src/plugins/agent-runtime/agentViews/text.js\":\"d34b5f31b55c0ed3\",\"/knowledge-medium/src/plugins/agent-runtime/agentWrites.js\":\"b67e8f1702b327af\",\"/knowledge-medium/src/plugins/agent-runtime/authoringCatalog.js\":\"f41f90d7bbf07214\",\"/knowledge-medium/src/plugins/agent-runtime/blockRefTargets.js\":\"b26ce80c4e5428b4\",\"/knowledge-medium/src/plugins/agent-runtime/bridge.js\":\"9a23d42ec4bf9a5a\",\"/knowledge-medium/src/plugins/agent-runtime/bridgeLoop.js\":\"2b28e1d4455fbf9d\",\"/knowledge-medium/src/plugins/agent-runtime/changeHistory.js\":\"276785bc401de133\",\"/knowledge-medium/src/plugins/agent-runtime/commands.js\":\"df5117086597f104\",\"/knowledge-medium/src/plugins/agent-runtime/commentsCommands.js\":\"35c1cb834ec4f67a\",\"/knowledge-medium/src/plugins/agent-runtime/dataExtension.js\":\"b60a20522ab716ff\",\"/knowledge-medium/src/plugins/agent-runtime/dataModelGuide.js\":\"7656d70f82c4e5e1\",\"/knowledge-medium/src/plugins/agent-runtime/dayPropertyInputs.js\":\"caebba7e70cb9c41\",\"/knowledge-medium/src/plugins/agent-runtime/describeRuntime.js\":\"012a78b5372260c8\",\"/knowledge-medium/src/plugins/agent-runtime/extensionLint.js\":\"54e01446ed33acb8\",\"/knowledge-medium/src/plugins/agent-runtime/grainAudit.js\":\"bb937703294ecd46\",\"/knowledge-medium/src/plugins/agent-runtime/healthCommand.js\":\"17ce7a8ba4119a65\",\"/knowledge-medium/src/plugins/agent-runtime/index.js\":\"389460cd646d2d12\",\"/knowledge-medium/src/plugins/agent-runtime/presetIdentity.js\":\"2884d0ebee218375\",\"/knowledge-medium/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"d7a982f3a25bc9b1\",\"/knowledge-medium/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/agent-runtime/readMedia.js\":\"d9aa149365c3135d\",\"/knowledge-medium/src/plugins/agent-runtime/schema.js\":\"97ce277895bab1b2\",\"/knowledge-medium/src/plugins/agent-runtime/serialization.js\":\"6c5cb355ca42ace7\",\"/knowledge-medium/src/plugins/agent-runtime/targets.js\":\"7f1e59ed30f59ef0\",\"/knowledge-medium/src/plugins/agent-runtime/tokens.js\":\"ee224909c8e4dc0c\",\"/knowledge-medium/src/plugins/agent-runtime/watchEvents.js\":\"98a72f836924bac5\",\"/knowledge-medium/src/plugins/agent-runtime/workspaceGuard.js\":\"2346340eef81c470\",\"/knowledge-medium/src/plugins/agent-runtime/writeCommands.js\":\"212492c26f9d3f21\",\"/knowledge-medium/src/plugins/alias/AliasCollisionToast.js\":\"643238cf43e0874b\",\"/knowledge-medium/src/plugins/alias/DuplicateNameBanner.js\":\"d674ff2f7cc376ec\",\"/knowledge-medium/src/plugins/alias/collisionMerge.js\":\"d9bbd1da48b85aa7\",\"/knowledge-medium/src/plugins/alias/dataExtension.js\":\"ec2aad7a17673536\",\"/knowledge-medium/src/plugins/alias/index.js\":\"374f5bbf22bfc4c0\",\"/knowledge-medium/src/plugins/alias/mergeCollisionAction.js\":\"28e99436c9422e9f\",\"/knowledge-medium/src/plugins/alias/pageStyling.js\":\"898cbfb1bc589f77\",\"/knowledge-medium/src/plugins/alias/rejectionToast.js\":\"8796c874dcc7cbfc\",\"/knowledge-medium/src/plugins/alias/syncProcessor.js\":\"6b92375cdab3508a\",\"/knowledge-medium/src/plugins/annotations/actions.js\":\"03baddd168d5933e\",\"/knowledge-medium/src/plugins/annotations/addComment.js\":\"3e9769d1424cd1ec\",\"/knowledge-medium/src/plugins/annotations/anchor.js\":\"7ea459f8bfbe6f30\",\"/knowledge-medium/src/plugins/annotations/anchorState.js\":\"ac59bf7772a04a69\",\"/knowledge-medium/src/plugins/annotations/commentLinks.js\":\"5b047477ad336e79\",\"/knowledge-medium/src/plugins/annotations/confirmThreadDeletion.js\":\"8f5ecff32e0cb89e\",\"/knowledge-medium/src/plugins/annotations/container.js\":\"164479856ca0efab\",\"/knowledge-medium/src/plugins/annotations/dataExtension.js\":\"7f6aca1d4f3d6ddd\",\"/knowledge-medium/src/plugins/annotations/deleteComment.js\":\"df67da8c5044c6ea\",\"/knowledge-medium/src/plugins/annotations/highlights.js\":\"61833d26e523ff98\",\"/knowledge-medium/src/plugins/annotations/index.js\":\"0116d75d82e58674\",\"/knowledge-medium/src/plugins/annotations/linkedCommentsPill.js\":\"9183a08ae59318ef\",\"/knowledge-medium/src/plugins/annotations/margin.js\":\"f9b7b75d8943b3ac\",\"/knowledge-medium/src/plugins/annotations/marginAnchorLinks.js\":\"d3de8f08177a8e7a\",\"/knowledge-medium/src/plugins/annotations/marginSchema.js\":\"eef989f1393e1623\",\"/knowledge-medium/src/plugins/annotations/newComment.js\":\"76af48b1d2aec72b\",\"/knowledge-medium/src/plugins/annotations/ownThreadPicker.js\":\"e2783ff83c6216e2\",\"/knowledge-medium/src/plugins/annotations/placement.js\":\"ba7b7c748ef06928\",\"/knowledge-medium/src/plugins/annotations/queries.js\":\"b0c0ed678662b0e5\",\"/knowledge-medium/src/plugins/annotations/quotePosition.js\":\"c7c95521ea698875\",\"/knowledge-medium/src/plugins/annotations/quotedIn.js\":\"52b947d1a8b10610\",\"/knowledge-medium/src/plugins/annotations/quotedRange.js\":\"fab99df3c95ae110\",\"/knowledge-medium/src/plugins/annotations/rangeRefs.js\":\"27a3d183909de8bc\",\"/knowledge-medium/src/plugins/annotations/readHighlights.js\":\"8556ba419679e0a5\",\"/knowledge-medium/src/plugins/annotations/readSelection.js\":\"fa00d6288167a279\",\"/knowledge-medium/src/plugins/annotations/readSelectionUi.js\":\"aa7188dd32346b58\",\"/knowledge-medium/src/plugins/annotations/reanchor.js\":\"24937474357fc333\",\"/knowledge-medium/src/plugins/annotations/schema.js\":\"8ae959a114a0b7b5\",\"/knowledge-medium/src/plugins/annotations/scope.js\":\"7ac1f640ad972a6e\",\"/knowledge-medium/src/plugins/annotations/scopeThreads.js\":\"a388d87a1d544284\",\"/knowledge-medium/src/plugins/annotations/splitRetarget.js\":\"9945ecf192d4f952\",\"/knowledge-medium/src/plugins/annotations/suggestionCard.js\":\"20590eb1b9298a83\",\"/knowledge-medium/src/plugins/annotations/suggestions.js\":\"0a33891826cc6434\",\"/knowledge-medium/src/plugins/annotations/summaries.js\":\"f65454c693b671ed\",\"/knowledge-medium/src/plugins/annotations/summaryBatch.js\":\"81cfa4294559a9ea\",\"/knowledge-medium/src/plugins/annotations/surface.js\":\"99ea5750a8d294cb\",\"/knowledge-medium/src/plugins/annotations/threadNavigation.js\":\"ed17ee509e2eca80\",\"/knowledge-medium/src/plugins/annotations/threads.js\":\"67e4cc8f3106c2a3\",\"/knowledge-medium/src/plugins/annotations/ui.js\":\"1e4ad4da9e30293e\",\"/knowledge-medium/src/plugins/annotations/uiStore.js\":\"dd7ce735e5e642a1\",\"/knowledge-medium/src/plugins/app-intents/appIntents.js\":\"27c9182c5e913069\",\"/knowledge-medium/src/plugins/app-intents/index.js\":\"873d67b820a1e6bb\",\"/knowledge-medium/src/plugins/app-update-prompt/index.js\":\"c57c032d6ea794a4\",\"/knowledge-medium/src/plugins/app-update-prompt/status.js\":\"d2adff2dc6554392\",\"/knowledge-medium/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"102850a9815841ef\",\"/knowledge-medium/src/plugins/attachments/MediaBlockRenderer.js\":\"5308aa1ef77c5f95\",\"/knowledge-medium/src/plugins/attachments/MediaDownLaneReplicator.js\":\"482882c293d09f97\",\"/knowledge-medium/src/plugins/attachments/MediaUploadReconciler.js\":\"1afdf30aabdd9d4a\",\"/knowledge-medium/src/plugins/attachments/assetDownLane.js\":\"04f96f8277527130\",\"/knowledge-medium/src/plugins/attachments/assetResolver.js\":\"add9c7c921bdbd8e\",\"/knowledge-medium/src/plugins/attachments/assetUpload.js\":\"48f37377d4d6b12d\",\"/knowledge-medium/src/plugins/attachments/attachmentCleanerIO.js\":\"798c38b8c5b2cca1\",\"/knowledge-medium/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/src/plugins/attachments/audit/supabaseAuditIO.js\":\"5dcbe5a44f3f147f\",\"/knowledge-medium/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/attachments/blobStore.js\":\"9fb9891cfed15e8d\",\"/knowledge-medium/src/plugins/attachments/browserMedia.js\":\"2a78d529d571171d\",\"/knowledge-medium/src/plugins/attachments/byteStore.js\":\"4cc522befaaa9554\",\"/knowledge-medium/src/plugins/attachments/cleanerIO.js\":\"5043259298bde1a1\",\"/knowledge-medium/src/plugins/attachments/cleanupAttachments.js\":\"103869ffb10ae79d\",\"/knowledge-medium/src/plugins/attachments/dataExtension.js\":\"371e18c601a42b08\",\"/knowledge-medium/src/plugins/attachments/downLane.js\":\"ee687e93e8396ce1\",\"/knowledge-medium/src/plugins/attachments/index.js\":\"ae15bdddb414f537\",\"/knowledge-medium/src/plugins/attachments/insertImageContribution.js\":\"9dd9faab7e12b99a\",\"/knowledge-medium/src/plugins/attachments/laneArming.js\":\"4abb1c6c02ba09e1\",\"/knowledge-medium/src/plugins/attachments/laneLock.js\":\"3517b18b08c0fe2b\",\"/knowledge-medium/src/plugins/attachments/mediaBlock.js\":\"b35ffe099e7a0925\",\"/knowledge-medium/src/plugins/attachments/mediaCapture.js\":\"25b6f4f41912e2bc\",\"/knowledge-medium/src/plugins/attachments/mediaLanes.js\":\"5e6c575e28b56c37\",\"/knowledge-medium/src/plugins/attachments/mediaViewers.js\":\"e8181487eb00d794\",\"/knowledge-medium/src/plugins/attachments/mediaViewersFacet.js\":\"80726ece5fb3561c\",\"/knowledge-medium/src/plugins/attachments/pasteCapture.js\":\"1a0110bcd2b75f3a\",\"/knowledge-medium/src/plugins/attachments/resolver.js\":\"540ff8dae09958f9\",\"/knowledge-medium/src/plugins/attachments/retryUploadsAction.js\":\"7ee488b56a53b3f3\",\"/knowledge-medium/src/plugins/attachments/storagePaths.js\":\"517d5491abf5ccd4\",\"/knowledge-medium/src/plugins/attachments/uploadDrain.js\":\"215e1d81d0232d48\",\"/knowledge-medium/src/plugins/attachments/uploadLaneStatus.js\":\"322ce35500b2c2da\",\"/knowledge-medium/src/plugins/attachments/uploadReconcile.js\":\"1faa8d034cd2b3dd\",\"/knowledge-medium/src/plugins/attachments/uploadRecovery.js\":\"cf929740a202a81c\",\"/knowledge-medium/src/plugins/attachments/uploadStore.js\":\"6410566e8d9d844f\",\"/knowledge-medium/src/plugins/attachments/useAssetObjectUrl.js\":\"3c8097f321fb11cb\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"02a34c65fe445b12\",\"/knowledge-medium/src/plugins/backlinks-view/BacklinksViewSection.js\":\"0156122ee575c62b\",\"/knowledge-medium/src/plugins/backlinks-view/facet.js\":\"062069a80f980bff\",\"/knowledge-medium/src/plugins/backlinks-view/index.js\":\"cf93f47eab2416b5\",\"/knowledge-medium/src/plugins/backlinks-view/prop.js\":\"ae2e8b0dbff27b9d\",\"/knowledge-medium/src/plugins/backlinks/BacklinkFilters.js\":\"11e7b9ac797fd9cd\",\"/knowledge-medium/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"ca897e3aecb4e765\",\"/knowledge-medium/src/plugins/backlinks/BlockEntry.js\":\"5d69f6f9ff2e5d75\",\"/knowledge-medium/src/plugins/backlinks/LinkedReferences.js\":\"3593c0376979c21a\",\"/knowledge-medium/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"b6c8cb6dbf8ad732\",\"/knowledge-medium/src/plugins/backlinks/dailyNoteDefaults.js\":\"bf05b92aba2bae47\",\"/knowledge-medium/src/plugins/backlinks/dataExtension.js\":\"19038e63f07f9637\",\"/knowledge-medium/src/plugins/backlinks/edgeExclusions.js\":\"c4ec6e670f5ac891\",\"/knowledge-medium/src/plugins/backlinks/filterProperty.js\":\"aca863f006696594\",\"/knowledge-medium/src/plugins/backlinks/index.js\":\"20c4f05c66318137\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"a66625eef4b5bf3e\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/applies.js\":\"6a3c03bf876c079a\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/countQuery.js\":\"ae98cba30cc94d66\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/expansionStore.js\":\"16f01cc411c8f18f\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/index.js\":\"f3329639c6008365\",\"/knowledge-medium/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"f096fe83d8495cb2\",\"/knowledge-medium/src/plugins/backlinks/presentationInvalidation.js\":\"2904d88fcbbf0103\",\"/knowledge-medium/src/plugins/backlinks/propertyEditorOverride.js\":\"f60c78db431638a3\",\"/knowledge-medium/src/plugins/backlinks/propertyFilter.js\":\"bc54752a0f2ba649\",\"/knowledge-medium/src/plugins/backlinks/query.js\":\"1451c52e9d125ce8\",\"/knowledge-medium/src/plugins/backlinks/resolveFilter.js\":\"f25e89fb13f2de58\",\"/knowledge-medium/src/plugins/backlinks/sourceBatch.js\":\"5083e558c5776301\",\"/knowledge-medium/src/plugins/backlinks/sources.js\":\"ac801775ae5debab\",\"/knowledge-medium/src/plugins/backlinks/useBacklinks.js\":\"85696856c3a4dfc2\",\"/knowledge-medium/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"ad1897d43ee3a8ab\",\"/knowledge-medium/src/plugins/birthday/BirthdayCelebration.js\":\"bf2db6d013d87622\",\"/knowledge-medium/src/plugins/birthday/BirthdayOverlay.js\":\"6f2e8dbda7868275\",\"/knowledge-medium/src/plugins/birthday/gate.js\":\"eb58bf2aa8906a87\",\"/knowledge-medium/src/plugins/birthday/index.js\":\"396a566de11926e0\",\"/knowledge-medium/src/plugins/birthday/wolfTheme.js\":\"ca71f40069aa2264\",\"/knowledge-medium/src/plugins/block-drag/BlockDragLayer.js\":\"d744335c1d44d827\",\"/knowledge-medium/src/plugins/block-drag/dragController.js\":\"a5b751288b5cc3ef\",\"/knowledge-medium/src/plugins/block-drag/dropTarget.js\":\"6d27965a06b4616a\",\"/knowledge-medium/src/plugins/block-drag/index.js\":\"18db29635f987a09\",\"/knowledge-medium/src/plugins/block-drag/projection.js\":\"60bb29a8c24ab420\",\"/knowledge-medium/src/plugins/block-info/BlockMetaCard.js\":\"7d38457ebb282344\",\"/knowledge-medium/src/plugins/block-info/index.js\":\"14d74f4ec8b865cb\",\"/knowledge-medium/src/plugins/block-tagging/AddTagDialog.js\":\"4d77aa04f6e447a1\",\"/knowledge-medium/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"f459d09f9a65f7f8\",\"/knowledge-medium/src/plugins/block-tagging/TagNameIssueHint.js\":\"a4d7797dd522ab7a\",\"/knowledge-medium/src/plugins/block-tagging/addTagAction.js\":\"8ba662c4bff711eb\",\"/knowledge-medium/src/plugins/block-tagging/appendTag.js\":\"df39c50dad5a9d6b\",\"/knowledge-medium/src/plugins/block-tagging/config.js\":\"5e0c4168400d2727\",\"/knowledge-medium/src/plugins/block-tagging/dataExtension.js\":\"49656e9cccc52b43\",\"/knowledge-medium/src/plugins/block-tagging/index.js\":\"c0132a7e17954913\",\"/knowledge-medium/src/plugins/block-tagging/propertyEditorOverride.js\":\"c6e5849b777cf500\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbList.js\":\"29b2da30748208fb\",\"/knowledge-medium/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"de5638d266de839c\",\"/knowledge-medium/src/plugins/breadcrumbs/Breadcrumbs.js\":\"db2f6aa9f8be4994\",\"/knowledge-medium/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"c45534980d1116a2\",\"/knowledge-medium/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"59137063fa4d24fc\",\"/knowledge-medium/src/plugins/breadcrumbs/index.js\":\"34ae6f1cf13a3896\",\"/knowledge-medium/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"e2a800260515b1a2\",\"/knowledge-medium/src/plugins/character-counter/CharacterCountItem.js\":\"574e69cfda064046\",\"/knowledge-medium/src/plugins/character-counter/ProfilePropertyEditor.js\":\"bed178b021d38211\",\"/knowledge-medium/src/plugins/character-counter/actions.js\":\"4fbb8c5ce78440ca\",\"/knowledge-medium/src/plugins/character-counter/blockType.js\":\"e95b334d6ff61788\",\"/knowledge-medium/src/plugins/character-counter/charCount.js\":\"dd84dc61283abf79\",\"/knowledge-medium/src/plugins/character-counter/dataExtension.js\":\"69f9ed26eef0cfd3\",\"/knowledge-medium/src/plugins/character-counter/index.js\":\"283f02de77f627c9\",\"/knowledge-medium/src/plugins/character-counter/profiles.js\":\"c3884bd75407e264\",\"/knowledge-medium/src/plugins/character-counter/properties.js\":\"4eaf1cb59c97ce5b\",\"/knowledge-medium/src/plugins/character-counter/subtree.js\":\"363f1b2df1c23bc0\",\"/knowledge-medium/src/plugins/character-counter/textCounts.js\":\"d3d74e9a8d691de4\",\"/knowledge-medium/src/plugins/colemak-keybindings/index.js\":\"f9a8ea472985af19\",\"/knowledge-medium/src/plugins/command-palette/CommandPalette.js\":\"a625933afaaeb15e\",\"/knowledge-medium/src/plugins/command-palette/HeaderItem.js\":\"6c4a23c1ed93af91\",\"/knowledge-medium/src/plugins/command-palette/context.js\":\"0a303e20eb65c6b3\",\"/knowledge-medium/src/plugins/command-palette/index.js\":\"2f978d5275bd5c9e\",\"/knowledge-medium/src/plugins/command-palette/selection.js\":\"f2db5f3912f7459f\",\"/knowledge-medium/src/plugins/command-palette/toggleStore.js\":\"4e76612c5d1bffe1\",\"/knowledge-medium/src/plugins/command-palette/useCommandPaletteActions.js\":\"7cadb45deaf27bb7\",\"/knowledge-medium/src/plugins/contributors/ContributorBadges.js\":\"651e3e7a05e895e8\",\"/knowledge-medium/src/plugins/contributors/author.js\":\"98595fb6abf16648\",\"/knowledge-medium/src/plugins/contributors/codeMirrorExtensions.js\":\"75d8e47712a01c92\",\"/knowledge-medium/src/plugins/contributors/dataExtension.js\":\"3fba7a91afe4daa7\",\"/knowledge-medium/src/plugins/contributors/index.js\":\"1a50c4c9995f620e\",\"/knowledge-medium/src/plugins/contributors/mentionAutocomplete.js\":\"2cc77ed500ec3119\",\"/knowledge-medium/src/plugins/contributors/processor.js\":\"8f339210d2b6b46f\",\"/knowledge-medium/src/plugins/contributors/profiles.js\":\"496c2ca9d9511937\",\"/knowledge-medium/src/plugins/contributors/queries.js\":\"38b6716d7c4358db\",\"/knowledge-medium/src/plugins/contributors/schema.js\":\"333ee466ae404cbe\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"406ef186b5bf1472\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/followOrigin.js\":\"f774db29dfbf4690\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/index.js\":\"9f5365988aed3543\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"a261bc75c0a2ad1d\",\"/knowledge-medium/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"af3d6d93447e7fc7\",\"/knowledge-medium/src/plugins/daily-notes/CalendarGrid.js\":\"1137bcdebeba71ec\",\"/knowledge-medium/src/plugins/daily-notes/DailyNotePicker.js\":\"7bed93503c783797\",\"/knowledge-medium/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"679a725ab76f75b4\",\"/knowledge-medium/src/plugins/daily-notes/DateNavDecorator.js\":\"b2b2e69e1b508e42\",\"/knowledge-medium/src/plugins/daily-notes/DateScrubOverlay.js\":\"61edf3c69edc7f85\",\"/knowledge-medium/src/plugins/daily-notes/DayPropertyEditor.js\":\"fe45e8cea1171bdd\",\"/knowledge-medium/src/plugins/daily-notes/HeaderItem.js\":\"0a024ad014a5e218\",\"/knowledge-medium/src/plugins/daily-notes/ReschedulePicker.js\":\"d338927ae3a501e3\",\"/knowledge-medium/src/plugins/daily-notes/SpreadDatesDialog.js\":\"9d0d2a988aeea5e8\",\"/knowledge-medium/src/plugins/daily-notes/actions.js\":\"b506fa0d386c5c55\",\"/knowledge-medium/src/plugins/daily-notes/blockDateAdapter.js\":\"7c0c1c0820c39156\",\"/knowledge-medium/src/plugins/daily-notes/calendar.js\":\"905433ca3e02401b\",\"/knowledge-medium/src/plugins/daily-notes/dailyNotes.js\":\"275b78042e45b25f\",\"/knowledge-medium/src/plugins/daily-notes/dataExtension.js\":\"4d5bce155078dc92\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubActions.js\":\"67498a9289bb3b22\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGesture.js\":\"d25e98492abe6d29\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubGestureActions.js\":\"bff9968bb9688abf\",\"/knowledge-medium/src/plugins/daily-notes/dateScrubRecognizer.js\":\"f57c1fd13c0dd6ec\",\"/knowledge-medium/src/plugins/daily-notes/dayProperty.js\":\"bbfe5a851903f706\",\"/knowledge-medium/src/plugins/daily-notes/deletionGuard.js\":\"b153c106779e2b93\",\"/knowledge-medium/src/plugins/daily-notes/dueQuery.js\":\"852ebaef89464ca5\",\"/knowledge-medium/src/plugins/daily-notes/index.js\":\"070e1d1da3851b37\",\"/knowledge-medium/src/plugins/daily-notes/landing.js\":\"c832486585783f97\",\"/knowledge-medium/src/plugins/daily-notes/localSchema.js\":\"b4bc696a1da7e4cf\",\"/knowledge-medium/src/plugins/daily-notes/referenceDateAdapter.js\":\"64d156cb1bdc56d6\",\"/knowledge-medium/src/plugins/daily-notes/rescheduleAction.js\":\"4daee2d68d97140f\",\"/knowledge-medium/src/plugins/daily-notes/schema.js\":\"06164d5e6b71641d\",\"/knowledge-medium/src/plugins/daily-notes/spreadBlockDates.js\":\"cabd3080a3872a22\",\"/knowledge-medium/src/plugins/daily-notes/spreadDatesAction.js\":\"dbaff3fb6baef2f0\",\"/knowledge-medium/src/plugins/daily-notes/today.js\":\"037a898308a5da21\",\"/knowledge-medium/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"9ca51177a69233b5\",\"/knowledge-medium/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"04d3cfb9603e9b40\",\"/knowledge-medium/src/plugins/data-integrity/audit.js\":\"7e050ed22dacb882\",\"/knowledge-medium/src/plugins/data-integrity/auditAction.js\":\"58c8cf981606668e\",\"/knowledge-medium/src/plugins/data-integrity/auditRanges.js\":\"c50a31af23e2eb94\",\"/knowledge-medium/src/plugins/data-integrity/diagnosticsSource.js\":\"cdea325e8b75d4bb\",\"/knowledge-medium/src/plugins/data-integrity/divergenceScan.js\":\"30c5971754cfb455\",\"/knowledge-medium/src/plugins/data-integrity/index.js\":\"3b06f8f06cdcaf82\",\"/knowledge-medium/src/plugins/data-integrity/propertyChildrenChecks.js\":\"8f65fd507589f5ca\",\"/knowledge-medium/src/plugins/data-integrity/referencesMirror.js\":\"cc20b5b24a3d8bd0\",\"/knowledge-medium/src/plugins/data-integrity/rowJson.js\":\"49c4bec127dcd06d\",\"/knowledge-medium/src/plugins/data-integrity/schedule.js\":\"39f1520e9e6be1c8\",\"/knowledge-medium/src/plugins/data-integrity/store.js\":\"473154156a184e30\",\"/knowledge-medium/src/plugins/db-maintenance/action.js\":\"b750ee700664a68d\",\"/knowledge-medium/src/plugins/db-maintenance/index.js\":\"5f6b16581976e83a\",\"/knowledge-medium/src/plugins/db-maintenance/plugin.js\":\"1832ec59ead7ed01\",\"/knowledge-medium/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"1cdf19fcf547bb84\",\"/knowledge-medium/src/plugins/db-mirror/actions.js\":\"e220a38c5241951a\",\"/knowledge-medium/src/plugins/db-mirror/changeMarker.js\":\"ae994bb8f89602a6\",\"/knowledge-medium/src/plugins/db-mirror/diagnostics.js\":\"1d812a0f615635bb\",\"/knowledge-medium/src/plugins/db-mirror/fileSystemAccess.js\":\"e005f736c103b5d6\",\"/knowledge-medium/src/plugins/db-mirror/filenames.js\":\"45dd449f5bb72236\",\"/knowledge-medium/src/plugins/db-mirror/index.js\":\"e5047d8fb900feaa\",\"/knowledge-medium/src/plugins/db-mirror/mirror.js\":\"899b1075c35e96d0\",\"/knowledge-medium/src/plugins/db-mirror/runLock.js\":\"5ce60d394972eee4\",\"/knowledge-medium/src/plugins/db-mirror/runtimeHealth.js\":\"153cf9e7025c494d\",\"/knowledge-medium/src/plugins/db-mirror/schedule.js\":\"4f5266e7d4960e96\",\"/knowledge-medium/src/plugins/db-mirror/store.js\":\"18e247d6e3e070e2\",\"/knowledge-medium/src/plugins/default-themes/index.js\":\"3e483d8134221ec2\",\"/knowledge-medium/src/plugins/default-themes/themes.js\":\"19cc158f831e0dbf\",\"/knowledge-medium/src/plugins/diagnostics/facet.js\":\"4d2253b68604a98c\",\"/knowledge-medium/src/plugins/diagnostics/useDiagnostics.js\":\"9113d633037675fc\",\"/knowledge-medium/src/plugins/extension-prompts/dismissals.js\":\"cb1dd3a7e063f35b\",\"/knowledge-medium/src/plugins/extension-prompts/index.js\":\"ccabe0655a5e2bfb\",\"/knowledge-medium/src/plugins/extension-prompts/status.js\":\"fc7b13f0f894c393\",\"/knowledge-medium/src/plugins/extension-prompts/store.js\":\"c828696306b7cf13\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"1f6077b9564aa251\",\"/knowledge-medium/src/plugins/extensions-settings/ExtensionsSettings.js\":\"1ebf8ca12c12d64c\",\"/knowledge-medium/src/plugins/extensions-settings/actions.js\":\"2172531eee89ec20\",\"/knowledge-medium/src/plugins/extensions-settings/config.js\":\"d93e0083134d4447\",\"/knowledge-medium/src/plugins/extensions-settings/dataExtension.js\":\"f7f235e164be85d8\",\"/knowledge-medium/src/plugins/extensions-settings/effect.js\":\"8651df81b5aa70f0\",\"/knowledge-medium/src/plugins/extensions-settings/index.js\":\"6bbf3ba0550ab101\",\"/knowledge-medium/src/plugins/extensions-settings/propertyEditorOverride.js\":\"66d3960fcc5eb389\",\"/knowledge-medium/src/plugins/extensions-settings/useToggleTree.js\":\"fde9c7e1856c6f69\",\"/knowledge-medium/src/plugins/extract-type/ExtractTypeDialog.js\":\"1e9539db298b5a49\",\"/knowledge-medium/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"c2ec81896ec664e7\",\"/knowledge-medium/src/plugins/extract-type/PropertyShapePicker.js\":\"7fc92b6f4cb53404\",\"/knowledge-medium/src/plugins/extract-type/action.js\":\"caeacfacc44ab022\",\"/knowledge-medium/src/plugins/extract-type/index.js\":\"58cfba610c485573\",\"/knowledge-medium/src/plugins/find-replace/FindReplaceDialog.js\":\"12cf95558fa43c3d\",\"/knowledge-medium/src/plugins/find-replace/HeaderItem.js\":\"1bc19cfc7ddb2b08\",\"/knowledge-medium/src/plugins/find-replace/dataExtension.js\":\"e662ede84497ca8e\",\"/knowledge-medium/src/plugins/find-replace/index.js\":\"2638d3ca26e3c7e5\",\"/knowledge-medium/src/plugins/find-replace/search.js\":\"07090a6d0cb7328a\",\"/knowledge-medium/src/plugins/find-replace/toggleStore.js\":\"a503adbb952f238e\",\"/knowledge-medium/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/plugins/geo/LocationPropertyEditor.js\":\"d8271e9cb28d5634\",\"/knowledge-medium/src/plugins/geo/MapView.js\":\"39b2d4c3c73ab694\",\"/knowledge-medium/src/plugins/geo/blockTypes.js\":\"b23bd018039b570a\",\"/knowledge-medium/src/plugins/geo/codeMirrorExtensions.js\":\"a7b9d43352ab1b03\",\"/knowledge-medium/src/plugins/geo/createOrFindPlace.js\":\"13dd3c577d21a8d1\",\"/knowledge-medium/src/plugins/geo/currentLocation.js\":\"fef72f0d5be5b5cc\",\"/knowledge-medium/src/plugins/geo/dataExtension.js\":\"e4b0a3ac05bf9aa1\",\"/knowledge-medium/src/plugins/geo/geoContentDecorator.js\":\"2b663d25a59d94d2\",\"/knowledge-medium/src/plugins/geo/googlePlacesClient.js\":\"37e912ef449679a0\",\"/knowledge-medium/src/plugins/geo/index.js\":\"d6833bfdc5d9d05a\",\"/knowledge-medium/src/plugins/geo/locationsPage.js\":\"e8ad5fe1b01c56c1\",\"/knowledge-medium/src/plugins/geo/mapViewport.js\":\"8b0841c1a9ccf599\",\"/knowledge-medium/src/plugins/geo/pickCurrentLocation.js\":\"78c65a9cb1fa31a4\",\"/knowledge-medium/src/plugins/geo/placeAutocomplete.js\":\"16297e358a823962\",\"/knowledge-medium/src/plugins/geo/placeNameCollision.js\":\"f38af630111e50aa\",\"/knowledge-medium/src/plugins/geo/properties.js\":\"ccd5e2ed98ccc582\",\"/knowledge-medium/src/plugins/geo/propertyEditorOverrides.js\":\"40622c66eb1c0ffd\",\"/knowledge-medium/src/plugins/geo/query.js\":\"4613c6ef48221d04\",\"/knowledge-medium/src/plugins/geo/usePlaceSearch.js\":\"a10a88741387baaa\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"ae99afd703377b44\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"7c1f2857925cae6d\",\"/knowledge-medium/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"149104361d71c068\",\"/knowledge-medium/src/plugins/grouped-backlinks/config.js\":\"28789b596ab9ac55\",\"/knowledge-medium/src/plugins/grouped-backlinks/dataExtension.js\":\"4a9b459396170bbd\",\"/knowledge-medium/src/plugins/grouped-backlinks/facet.js\":\"fe42082776e11f45\",\"/knowledge-medium/src/plugins/grouped-backlinks/grouping.js\":\"1e269e296e4640e4\",\"/knowledge-medium/src/plugins/grouped-backlinks/index.js\":\"b355d3ca0cfffd06\",\"/knowledge-medium/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"8c8954beb0f8ccc5\",\"/knowledge-medium/src/plugins/grouped-backlinks/query.js\":\"a5ac1ee45a0e471e\",\"/knowledge-medium/src/plugins/grouped-backlinks/resolveConfig.js\":\"460aeb1722bf6181\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"5c1c4b3cb8c2a27a\",\"/knowledge-medium/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"43d2058e0e1ffc15\",\"/knowledge-medium/src/plugins/html-document/HtmlDocumentContent.js\":\"cc7ade3fbc6eecdb\",\"/knowledge-medium/src/plugins/html-document/HtmlFrame.js\":\"412e6487c7a1d37f\",\"/knowledge-medium/src/plugins/html-document/actions.js\":\"9e0a52164e9b49f5\",\"/knowledge-medium/src/plugins/html-document/blockType.js\":\"11fd298386b81192\",\"/knowledge-medium/src/plugins/html-document/confirmRunScripts.js\":\"148280e05625af40\",\"/knowledge-medium/src/plugins/html-document/dataExtension.js\":\"d871a8cdf19deb0d\",\"/knowledge-medium/src/plugins/html-document/frameAnnotations.js\":\"1c5785e6d5f59400\",\"/knowledge-medium/src/plugins/html-document/frameDocument.js\":\"926e3abe16662a08\",\"/knowledge-medium/src/plugins/html-document/frameTheme.js\":\"7b341d4565d44817\",\"/knowledge-medium/src/plugins/html-document/index.js\":\"321fafb8e1f48eee\",\"/knowledge-medium/src/plugins/html-document/scriptConsent.js\":\"c3803a9eeace81c8\",\"/knowledge-medium/src/plugins/html-document/sourceMap.js\":\"3281beb89df653ee\",\"/knowledge-medium/src/plugins/html-document/useDocumentScripts.js\":\"ad3fe67f54822eb8\",\"/knowledge-medium/src/plugins/interaction-metrics/index.js\":\"b6c56d5ab80807d1\",\"/knowledge-medium/src/plugins/interaction-metrics/record.js\":\"8ca422e8135e3003\",\"/knowledge-medium/src/plugins/interaction-metrics/recordStore.js\":\"0191795f4dad80e3\",\"/knowledge-medium/src/plugins/interaction-metrics/responsiveness.js\":\"bf6ac4965bf4f03a\",\"/knowledge-medium/src/plugins/interaction-metrics/schedule.js\":\"f0800979438ac3e0\",\"/knowledge-medium/src/plugins/interaction-metrics/sessionContext.js\":\"369f6caf1284d751\",\"/knowledge-medium/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"2722b3d8d45ea1f5\",\"/knowledge-medium/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"5dfff552c8217eba\",\"/knowledge-medium/src/plugins/keybindings-settings/actions.js\":\"72260bc81e86d89e\",\"/knowledge-medium/src/plugins/keybindings-settings/config.js\":\"0b9005caaa6c6340\",\"/knowledge-medium/src/plugins/keybindings-settings/dataExtension.js\":\"21351f2d0fd68dc2\",\"/knowledge-medium/src/plugins/keybindings-settings/effect.js\":\"f10ef41afef2c444\",\"/knowledge-medium/src/plugins/keybindings-settings/index.js\":\"d22719c43495b81a\",\"/knowledge-medium/src/plugins/keybindings-settings/keyCapture.js\":\"143912a0a339c38c\",\"/knowledge-medium/src/plugins/keybindings-settings/overrideStore.js\":\"38eea98706f3e395\",\"/knowledge-medium/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"e7c985449f32f865\",\"/knowledge-medium/src/plugins/left-sidebar/HeaderItem.js\":\"88dd49f99b9e6ef8\",\"/knowledge-medium/src/plugins/left-sidebar/LeftSidebar.js\":\"11a365d01f6a2133\",\"/knowledge-medium/src/plugins/left-sidebar/actions.js\":\"12f9f8b92698b5e5\",\"/knowledge-medium/src/plugins/left-sidebar/facet.js\":\"7dec76d44e8c4487\",\"/knowledge-medium/src/plugins/left-sidebar/index.js\":\"7cbdf7d133201f55\",\"/knowledge-medium/src/plugins/left-sidebar/shortcuts.js\":\"4178ef3e477f11d7\",\"/knowledge-medium/src/plugins/left-sidebar/toggleStore.js\":\"96cb2ff0097e44f0\",\"/knowledge-medium/src/plugins/merge-blocks/MergePicker.js\":\"d10b0c527bba40c4\",\"/knowledge-medium/src/plugins/merge-blocks/index.js\":\"d23654a9aa2a3ea9\",\"/knowledge-medium/src/plugins/merge-blocks/mergeAction.js\":\"43421e5cf92be00a\",\"/knowledge-medium/src/plugins/merge-blocks/strategy.js\":\"947d93ba2a4d08f5\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/Button.js\":\"6639571aa4fa82fc\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"41bbf4fc19a777ce\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/defaultItems.js\":\"7fa728ea0b84a8ce\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/facet.js\":\"8969f5b005a484c2\",\"/knowledge-medium/src/plugins/mobile-bottom-nav/index.js\":\"1aca8ef95d880b14\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"94001ae6a56cb66d\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/actions.js\":\"0f9f0c8b0cb949af\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"cfe6fb26d573b8e4\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/facet.js\":\"9c0f0b437e99615c\",\"/knowledge-medium/src/plugins/mobile-keyboard-toolbar/index.js\":\"9fabb095ffed9722\",\"/knowledge-medium/src/plugins/move-blocks/MoveDestinationPicker.js\":\"2ac5b28ceeb716c8\",\"/knowledge-medium/src/plugins/move-blocks/blockSubtreeMembership.js\":\"70d510eb0be08962\",\"/knowledge-medium/src/plugins/move-blocks/contextMenuItem.js\":\"8a156239a2a2addf\",\"/knowledge-medium/src/plugins/move-blocks/index.js\":\"98c02c620af9b264\",\"/knowledge-medium/src/plugins/move-blocks/moveAction.js\":\"69eeb825ada5f536\",\"/knowledge-medium/src/plugins/move-blocks/moveBlocks.js\":\"5a06c86f88d99237\",\"/knowledge-medium/src/plugins/move-blocks/selectionAfterMove.js\":\"60da0709039acc6f\",\"/knowledge-medium/src/plugins/onboarding/TutorialBanner.js\":\"b5aba6e928dd9556\",\"/knowledge-medium/src/plugins/onboarding/action.js\":\"e9318a38559515b1\",\"/knowledge-medium/src/plugins/onboarding/bannerDismissal.js\":\"27917fec8e65a2c1\",\"/knowledge-medium/src/plugins/onboarding/documents/cheatSheet.js\":\"3bb7e7dc5c68a4e6\",\"/knowledge-medium/src/plugins/onboarding/index.js\":\"5442f34add6671a3\",\"/knowledge-medium/src/plugins/onboarding/keys.js\":\"46870fdb145bcf47\",\"/knowledge-medium/src/plugins/onboarding/landing.js\":\"621d372f1b5ebe64\",\"/knowledge-medium/src/plugins/onboarding/outline.js\":\"58b0664a7278c022\",\"/knowledge-medium/src/plugins/onboarding/seed.js\":\"196879afb1bb3373\",\"/knowledge-medium/src/plugins/perf-monitor/PerfTrendDialog.js\":\"12a63e1a46ccf36b\",\"/knowledge-medium/src/plugins/perf-monitor/analyze.js\":\"6a4ee28993a9be36\",\"/knowledge-medium/src/plugins/perf-monitor/diagnosticsSource.js\":\"b8f29bd75a37b1c4\",\"/knowledge-medium/src/plugins/perf-monitor/index.js\":\"f6a79b193764af08\",\"/knowledge-medium/src/plugins/perf-monitor/load.js\":\"55ee4d36d8a9449c\",\"/knowledge-medium/src/plugins/perf-monitor/monitorRun.js\":\"8365ef4b3cff6623\",\"/knowledge-medium/src/plugins/perf-monitor/schedule.js\":\"8a4c9acf02687f1e\",\"/knowledge-medium/src/plugins/perf-monitor/series.js\":\"1eed390dcc3b0add\",\"/knowledge-medium/src/plugins/perf-monitor/store.js\":\"535eb78f4d06fe4b\",\"/knowledge-medium/src/plugins/perf-monitor/trendAction.js\":\"34be4af1ab6dfac9\",\"/knowledge-medium/src/plugins/perf-monitor/verdict.js\":\"d9a8f188f8e99cd5\",\"/knowledge-medium/src/plugins/plain-outliner/clickToEditAction.js\":\"dbe606b68ae8d043\",\"/knowledge-medium/src/plugins/plain-outliner/index.js\":\"c8644b790df36519\",\"/knowledge-medium/src/plugins/plain-outliner/interactions.js\":\"5e5be4a02db4760f\",\"/knowledge-medium/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"0be98eae86e9091f\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGate.js\":\"6b35d318b73a61be\",\"/knowledge-medium/src/plugins/properties-migration/MigrationGateDialog.js\":\"328ab24bc4e53611\",\"/knowledge-medium/src/plugins/properties-migration/action.js\":\"0d503b71f313580b\",\"/knowledge-medium/src/plugins/properties-migration/index.js\":\"699ec0a1c66d0454\",\"/knowledge-medium/src/plugins/properties-migration/localRunMessage.js\":\"0c95895e1f1be76f\",\"/knowledge-medium/src/plugins/properties-migration/plugin.js\":\"69541e27289e3cfa\",\"/knowledge-medium/src/plugins/properties-migration/progressReport.js\":\"115ef0ce2b2f887c\",\"/knowledge-medium/src/plugins/properties-migration/sweepProgress.js\":\"9e3347d983fb6367\",\"/knowledge-medium/src/plugins/property-rows/FieldRowRenderer.js\":\"13059be62c6258e3\",\"/knowledge-medium/src/plugins/property-rows/ValueRowRenderer.js\":\"61c1b5925987a1c6\",\"/knowledge-medium/src/plugins/property-rows/actions.js\":\"6e875db145ed3c98\",\"/knowledge-medium/src/plugins/property-rows/autocomplete.js\":\"aadd79107421c81f\",\"/knowledge-medium/src/plugins/property-rows/fieldRow.js\":\"9f9bb045d9d6363c\",\"/knowledge-medium/src/plugins/property-rows/index.js\":\"4b56c7071864ceee\",\"/knowledge-medium/src/plugins/property-rows/referenceWarning.js\":\"0019737aa5f8f98f\",\"/knowledge-medium/src/plugins/property-rows/valueAutocomplete.js\":\"0359c42d7c923fac\",\"/knowledge-medium/src/plugins/property-rows/valueSchema.js\":\"6fb0741350aefb82\",\"/knowledge-medium/src/plugins/quick-find/HeaderItem.js\":\"bb9d1069a909a37c\",\"/knowledge-medium/src/plugins/quick-find/QuickFind.js\":\"ed57ac471867226e\",\"/knowledge-medium/src/plugins/quick-find/index.js\":\"ad2db8fdda947c85\",\"/knowledge-medium/src/plugins/quick-find/recents.js\":\"44009e44c39ad40c\",\"/knowledge-medium/src/plugins/quick-find/resultItems.js\":\"7a5f88fe5194e629\",\"/knowledge-medium/src/plugins/quick-find/selection.js\":\"9789a1c542225b05\",\"/knowledge-medium/src/plugins/quick-find/toggleStore.js\":\"056e0854f9d8b05d\",\"/knowledge-medium/src/plugins/recents/HeaderItem.js\":\"49ceb0735d196b53\",\"/knowledge-medium/src/plugins/recents/RecentsPageBlockRenderer.js\":\"309e5c3e78ce5a4d\",\"/knowledge-medium/src/plugins/recents/grouping.js\":\"1836adf80f460163\",\"/knowledge-medium/src/plugins/recents/index.js\":\"5ea953d5b6cf6ee8\",\"/knowledge-medium/src/plugins/recents/target.js\":\"ad4e492d45a6a566\",\"/knowledge-medium/src/plugins/references/codeMirrorExtensions.js\":\"a709e76471fd27e6\",\"/knowledge-medium/src/plugins/references/contentPrefill.js\":\"5f0190f9d6d7e8e5\",\"/knowledge-medium/src/plugins/references/dataExtension.js\":\"4bb0fb2a9d7a5181\",\"/knowledge-medium/src/plugins/references/index.js\":\"90788e5e7f726ebb\",\"/knowledge-medium/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"cb54c7703489cbe1\",\"/knowledge-medium/src/plugins/references/invalidation.js\":\"baab58e2ac313330\",\"/knowledge-medium/src/plugins/references/localSchema.js\":\"9f9771ca189d04b1\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/index.js\":\"511cdf5c22cf303b\",\"/knowledge-medium/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"0810da82af9d8cc3\",\"/knowledge-medium/src/plugins/references/markdown/index.js\":\"1510d46625ee0c13\",\"/knowledge-medium/src/plugins/references/markdown/referenceNode.js\":\"94b71a3325f633a6\",\"/knowledge-medium/src/plugins/references/markdown/remark-reference-occurrences.js\":\"9b654221b838ae75\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"6852f75715f31d2c\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/index.js\":\"71f5a9c533312550\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"4add4ea695e779a5\",\"/knowledge-medium/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"37229ac3de96f46b\",\"/knowledge-medium/src/plugins/references/mergeRetargetProcessor.js\":\"e6b029b0e8f16dd5\",\"/knowledge-medium/src/plugins/references/parseFence.js\":\"96ed4ea9f9c63024\",\"/knowledge-medium/src/plugins/references/referenceParser.js\":\"1dc3ced7577f5b57\",\"/knowledge-medium/src/plugins/references/referenceProjection.js\":\"df3e74d8df3bb1c7\",\"/knowledge-medium/src/plugins/references/referencesProcessor.js\":\"12aac4acc72ac579\",\"/knowledge-medium/src/plugins/references/renameProcessor.js\":\"5ce016f9e3ff6b19\",\"/knowledge-medium/src/plugins/references/spanReplacement.js\":\"e8856bab1a744814\",\"/knowledge-medium/src/plugins/rich-paste/htmlToOutline.js\":\"bce823f9a93246a0\",\"/knowledge-medium/src/plugins/rich-paste/index.js\":\"7ffd6c92e7ef0f75\",\"/knowledge-medium/src/plugins/rich-paste/normalizeClipboardDom.js\":\"eb12adf9ee139375\",\"/knowledge-medium/src/plugins/rich-paste/pasteDecision.js\":\"5677a236f1957cc1\",\"/knowledge-medium/src/plugins/roam-import/action.js\":\"d72bc250ba4c99f1\",\"/knowledge-medium/src/plugins/roam-import/blockIds.js\":\"25f0da99e70b0648\",\"/knowledge-medium/src/plugins/roam-import/content.js\":\"f511ad9d3448ab41\",\"/knowledge-medium/src/plugins/roam-import/effect.js\":\"ae2525f9bcef544d\",\"/knowledge-medium/src/plugins/roam-import/ids.js\":\"f227ec12036c6295\",\"/knowledge-medium/src/plugins/roam-import/import.js\":\"7649c935912ffc2a\",\"/knowledge-medium/src/plugins/roam-import/index.js\":\"adffe50ce62a0a73\",\"/knowledge-medium/src/plugins/roam-import/plan.js\":\"ae10c341ddd3dc3a\",\"/knowledge-medium/src/plugins/roam-import/plugin.js\":\"9a8b4e4c21d95e7f\",\"/knowledge-medium/src/plugins/roam-import/promotion.js\":\"6a6385cc5f9f2b82\",\"/knowledge-medium/src/plugins/roam-import/properties.js\":\"68627e42db54b2ab\",\"/knowledge-medium/src/plugins/roam-import/references.js\":\"7602c5d793a34cfa\",\"/knowledge-medium/src/plugins/roam-import/report.js\":\"24189e3df9409c89\",\"/knowledge-medium/src/plugins/roam-import/roamMemo.js\":\"d6c0ba6651d6f081\",\"/knowledge-medium/src/plugins/roam-import/runtime.js\":\"9162a4f5507e4b4a\",\"/knowledge-medium/src/plugins/roam-import/schemaReconciliation.js\":\"11812a7520b0819c\",\"/knowledge-medium/src/plugins/roam-import/srsMarkers.js\":\"9a818459539edba8\",\"/knowledge-medium/src/plugins/roam-import/todo.js\":\"6784e6ac5007b130\",\"/knowledge-medium/src/plugins/roam-import/typeCandidates.js\":\"158780f6ebbc646b\",\"/knowledge-medium/src/plugins/roam-import/types.js\":\"69fc71e1e13e3f00\",\"/knowledge-medium/src/plugins/search-health/index.js\":\"01cad2344e376f09\",\"/knowledge-medium/src/plugins/search-health/store.js\":\"e6887047aed43c71\",\"/knowledge-medium/src/plugins/shortcut-help/HeaderItem.js\":\"5cdd51724a650bbf\",\"/knowledge-medium/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"3371006d0448fcab\",\"/knowledge-medium/src/plugins/shortcut-help/index.js\":\"1167e73413ba2382\",\"/knowledge-medium/src/plugins/shortcut-help/model.js\":\"e4608dbded6234bd\",\"/knowledge-medium/src/plugins/shortcut-help/toggleStore.js\":\"bb44f6fa2ea9b218\",\"/knowledge-medium/src/plugins/shortcut-help/useKeyInspector.js\":\"77be1528e9999886\",\"/knowledge-medium/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"b9470dc3803c0185\",\"/knowledge-medium/src/plugins/spatial-navigation/ShellDecorator.js\":\"a6bc3964dac7ea54\",\"/knowledge-medium/src/plugins/spatial-navigation/actions.js\":\"c9063a0816fe00df\",\"/knowledge-medium/src/plugins/spatial-navigation/exclusionsFacet.js\":\"a3eed3d6a3639a9e\",\"/knowledge-medium/src/plugins/spatial-navigation/index.js\":\"89cb1db26538c27e\",\"/knowledge-medium/src/plugins/spatial-navigation/shell.js\":\"9acf464b706940ad\",\"/knowledge-medium/src/plugins/spatial-navigation/surface.js\":\"3a64d4b0edd5b0ff\",\"/knowledge-medium/src/plugins/spatial-navigation/walker.js\":\"179955d49fd62041\",\"/knowledge-medium/src/plugins/srs-rescheduling/RescheduleToast.js\":\"0baadee799e58529\",\"/knowledge-medium/src/plugins/srs-rescheduling/dataExtension.js\":\"aed899fa19d33bb4\",\"/knowledge-medium/src/plugins/srs-rescheduling/index.js\":\"e059eb3abe5edd89\",\"/knowledge-medium/src/plugins/srs-rescheduling/indicator.js\":\"7ddccfe9508bf01a\",\"/knowledge-medium/src/plugins/srs-rescheduling/moveSrsState.js\":\"8d97b7669c588255\",\"/knowledge-medium/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"a4c4a002f8817e84\",\"/knowledge-medium/src/plugins/srs-rescheduling/scheduler.js\":\"3016384a4da744b3\",\"/knowledge-medium/src/plugins/srs-rescheduling/schema.js\":\"2931ca2ce003ce37\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"75fd242aee3f5343\",\"/knowledge-medium/src/plugins/srs-rescheduling/srsClipboard.js\":\"99269af091016542\",\"/knowledge-medium/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"90a6f3bb9cd2bbc1\",\"/knowledge-medium/src/plugins/srs-review/DailyNoteReviewHint.js\":\"91c654ba224d608a\",\"/knowledge-medium/src/plugins/srs-review/DeckPicker.js\":\"37ec087fa7f7d50a\",\"/knowledge-medium/src/plugins/srs-review/ReviewControls.js\":\"7fd2084e6f2da633\",\"/knowledge-medium/src/plugins/srs-review/ReviewDeckRenderer.js\":\"ddb4243ac06ba7e6\",\"/knowledge-medium/src/plugins/srs-review/ReviewSession.js\":\"799ab3a465a2882a\",\"/knowledge-medium/src/plugins/srs-review/actions.js\":\"e9b45e57e750e445\",\"/knowledge-medium/src/plugins/srs-review/archive.js\":\"41f529c983294e81\",\"/knowledge-medium/src/plugins/srs-review/dataExtension.js\":\"b5454d4d55b1c465\",\"/knowledge-medium/src/plugins/srs-review/deck.js\":\"e0bc26463f2b92bc\",\"/knowledge-medium/src/plugins/srs-review/dueQuery.js\":\"98e8688487626345\",\"/knowledge-medium/src/plugins/srs-review/gradeDecision.js\":\"995312bf4a054525\",\"/knowledge-medium/src/plugins/srs-review/index.js\":\"bc60bc7ba431f9dc\",\"/knowledge-medium/src/plugins/srs-review/keyHints.js\":\"a164dbc4b5e9dd26\",\"/knowledge-medium/src/plugins/srs-review/reviewCardLayout.js\":\"54f78f7637116784\",\"/knowledge-medium/src/plugins/srs-review/reviewProgress.js\":\"8ed3fad75bf86f71\",\"/knowledge-medium/src/plugins/srs-review/schema.js\":\"2bf4527e66a3bdef\",\"/knowledge-medium/src/plugins/srs-review/useDueCards.js\":\"88705b51cfc491d6\",\"/knowledge-medium/src/plugins/startup-metrics/index.js\":\"a6032781afb216ac\",\"/knowledge-medium/src/plugins/startup-metrics/record.js\":\"8adaf1be859700dc\",\"/knowledge-medium/src/plugins/storage-persistence/index.js\":\"c5821c35893771a4\",\"/knowledge-medium/src/plugins/storage-persistence/persistenceStatus.js\":\"d2f3d4d2c31ecd82\",\"/knowledge-medium/src/plugins/storage-persistence/requestAction.js\":\"6b97b5b5ab955e36\",\"/knowledge-medium/src/plugins/supertags/TypeChipsDecorator.js\":\"c98a65cbca6c4fd4\",\"/knowledge-medium/src/plugins/supertags/codeMirrorExtensions.js\":\"a2f53f3c4f21de58\",\"/knowledge-medium/src/plugins/supertags/index.js\":\"6967c5e3f03643e0\",\"/knowledge-medium/src/plugins/supertags/typeAutocomplete.js\":\"0cb1bb818710e23e\",\"/knowledge-medium/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"53e7f1817db15d5f\",\"/knowledge-medium/src/plugins/swipe-quick-actions/actions.js\":\"854d679a98c71e89\",\"/knowledge-medium/src/plugins/swipe-quick-actions/anchor.js\":\"d80e642b2ca57a45\",\"/knowledge-medium/src/plugins/swipe-quick-actions/events.js\":\"1d621b0778564e3f\",\"/knowledge-medium/src/plugins/swipe-quick-actions/gestureActions.js\":\"68ef7e9e4a5a57af\",\"/knowledge-medium/src/plugins/swipe-quick-actions/index.js\":\"428a52ed14c731b9\",\"/knowledge-medium/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"89daa9f164e5c97e\",\"/knowledge-medium/src/plugins/sync-metrics/collect.js\":\"2e722dfdec2f4559\",\"/knowledge-medium/src/plugins/sync-metrics/index.js\":\"84a54ff7fa5aad43\",\"/knowledge-medium/src/plugins/sync-metrics/record.js\":\"46e70470cacff99a\",\"/knowledge-medium/src/plugins/system-status/RejectionDialog.js\":\"8c58209d526f33e8\",\"/knowledge-medium/src/plugins/system-status/SystemStatusHeaderItem.js\":\"2861263bb5b9b169\",\"/knowledge-medium/src/plugins/system-status/index.js\":\"051ec1729941b313\",\"/knowledge-medium/src/plugins/system-status/model.js\":\"9e5fe947af90eb91\",\"/knowledge-medium/src/plugins/system-status/queueCounts.js\":\"96b42ecff72a1b82\",\"/knowledge-medium/src/plugins/system-status/rejectedHelpers.js\":\"b4339f0f8363942d\",\"/knowledge-medium/src/plugins/system-status/rematerializeAction.js\":\"0612befae1551387\",\"/knowledge-medium/src/plugins/system-status/useHysteresis.js\":\"5b6f21a0c40f6bca\",\"/knowledge-medium/src/plugins/tables/ColumnHeaders.js\":\"b85de4e28e59d59a\",\"/knowledge-medium/src/plugins/tables/QueryUi.js\":\"955451b45cc256ff\",\"/knowledge-medium/src/plugins/tables/TableLayout.js\":\"1dead2593205503d\",\"/knowledge-medium/src/plugins/tables/actions.js\":\"146043ebd56ee65d\",\"/knowledge-medium/src/plugins/tables/cellEdits.js\":\"f2d36299546d72b6\",\"/knowledge-medium/src/plugins/tables/childrenViews.js\":\"d92826c1722d6fcc\",\"/knowledge-medium/src/plugins/tables/columns.js\":\"0be753a47954b590\",\"/knowledge-medium/src/plugins/tables/controller.js\":\"30d749a5c8fe5222\",\"/knowledge-medium/src/plugins/tables/convert.js\":\"aa725c223cda0f65\",\"/knowledge-medium/src/plugins/tables/dataExtension.js\":\"3540583994033707\",\"/knowledge-medium/src/plugins/tables/index.js\":\"abdeef7c518b601b\",\"/knowledge-medium/src/plugins/tables/keys.js\":\"b00cdd729e9de032\",\"/knowledge-medium/src/plugins/tables/model.js\":\"020386b0f1cf87a2\",\"/knowledge-medium/src/plugins/tables/query/QueryText.js\":\"39d42c3661197a18\",\"/knowledge-medium/src/plugins/tables/query/backfill.js\":\"33a6f3440902925d\",\"/knowledge-medium/src/plugins/tables/query/completion.js\":\"aef1b4008c2c842c\",\"/knowledge-medium/src/plugins/tables/query/format.js\":\"53377b203f20814c\",\"/knowledge-medium/src/plugins/tables/query/parse.js\":\"3a7ea3427f13cd14\",\"/knowledge-medium/src/plugins/tables/query/queryValue.js\":\"e8c21a987b6f40dd\",\"/knowledge-medium/src/plugins/tables/query/registrations.js\":\"a481dc0b196099e7\",\"/knowledge-medium/src/plugins/tables/query/source.js\":\"41f5d72272c6aba9\",\"/knowledge-medium/src/plugins/tables/registry.js\":\"14c9d4e46bb0a812\",\"/knowledge-medium/src/plugins/tables/rowGutter.js\":\"255cb0f7fa40b255\",\"/knowledge-medium/src/plugins/tables/rowVerbs.js\":\"1b644ee96bbf8d67\",\"/knowledge-medium/src/plugins/tables/schema.js\":\"c3c3b2a10fbbe14e\",\"/knowledge-medium/src/plugins/tables/sort.js\":\"170ce6c268485b59\",\"/knowledge-medium/src/plugins/theme-toggle/effect.js\":\"4398ba823f573fce\",\"/knowledge-medium/src/plugins/theme-toggle/index.js\":\"fd049f55ccafd675\",\"/knowledge-medium/src/plugins/theme-toggle/theme.js\":\"a69340fc923b67fd\",\"/knowledge-medium/src/plugins/todo/actions.js\":\"c3b5f9e7c017a8bc\",\"/knowledge-medium/src/plugins/todo/dataExtension.js\":\"b326b88782138d0b\",\"/knowledge-medium/src/plugins/todo/index.js\":\"6f83f7e6bd303ae8\",\"/knowledge-medium/src/plugins/todo/schema.js\":\"099a868c400ef779\",\"/knowledge-medium/src/plugins/touch-selection/TouchSelectionLayer.js\":\"8efd91cac7b48626\",\"/knowledge-medium/src/plugins/touch-selection/actions.js\":\"f59df9d622456401\",\"/knowledge-medium/src/plugins/touch-selection/defaultItems.js\":\"44e73aa0ec659dc0\",\"/knowledge-medium/src/plugins/touch-selection/facet.js\":\"fe0bf27674760f8f\",\"/knowledge-medium/src/plugins/touch-selection/holdRecognizer.js\":\"381d629fbc73dae2\",\"/knowledge-medium/src/plugins/touch-selection/index.js\":\"15f918b5680a5254\",\"/knowledge-medium/src/plugins/update-indicator/UpdateIndicator.js\":\"efd1f94adf08afbf\",\"/knowledge-medium/src/plugins/update-indicator/index.js\":\"249f74663507b435\",\"/knowledge-medium/src/plugins/update-indicator/loadTimes.js\":\"bb01708d8e295c8b\",\"/knowledge-medium/src/plugins/video-player/VideoNotesRenderer.js\":\"618a1a53ad533b81\",\"/knowledge-medium/src/plugins/video-player/VideoPlayerRenderer.js\":\"a0bf25caed0973f1\",\"/knowledge-medium/src/plugins/video-player/VideoTimeStamp.js\":\"5f80ab4a2068ae41\",\"/knowledge-medium/src/plugins/video-player/actions.js\":\"331c4320f77b0fd9\",\"/knowledge-medium/src/plugins/video-player/index.js\":\"16acca0bb1181ce5\",\"/knowledge-medium/src/plugins/video-player/markdown.js\":\"26ad72d25f7135ba\",\"/knowledge-medium/src/plugins/video-player/notes.js\":\"0d3449b5e7af14e2\",\"/knowledge-medium/src/plugins/video-player/registry.js\":\"fa67f889167d1edd\",\"/knowledge-medium/src/plugins/video-player/remark-timestamps.js\":\"32bc29f9cd834d68\",\"/knowledge-medium/src/plugins/video-player/view.js\":\"ed7a879dd4dbbaeb\",\"/knowledge-medium/src/plugins/vim-link-hints/LinkHints.js\":\"bfb7ad36f7888241\",\"/knowledge-medium/src/plugins/vim-link-hints/index.js\":\"a379dc2a5ba09742\",\"/knowledge-medium/src/plugins/vim-link-hints/model.js\":\"05995ae3435e12aa\",\"/knowledge-medium/src/plugins/vim-link-hints/settings.js\":\"f2d24440405aa311\",\"/knowledge-medium/src/plugins/vim-normal-mode/actions.js\":\"cb9c08c0d025a8fb\",\"/knowledge-medium/src/plugins/vim-normal-mode/index.js\":\"a0a23192f5074c0e\",\"/knowledge-medium/src/plugins/vim-normal-mode/interactions.js\":\"ed33a6ad246b650f\",\"/knowledge-medium/src/plugins/workspace-header/index.js\":\"29fa9034892c62a4\",\"/knowledge-medium/src/registerServiceWorker.js\":\"0bf2cfe9910ca904\",\"/knowledge-medium/src/requestPersistentStorage.js\":\"42ea0465bf7326bd\",\"/knowledge-medium/src/services/authRequestDeadline.js\":\"679f82f9ad4d9008\",\"/knowledge-medium/src/services/authStorage.js\":\"51c1dc81db16b512\",\"/knowledge-medium/src/services/powersync.js\":\"ff7e783b38c40ba8\",\"/knowledge-medium/src/services/supabase.js\":\"d813e932e2c64406\",\"/knowledge-medium/src/services/uploadErrorClassifier.js\":\"2ca049a527a1d98c\",\"/knowledge-medium/src/shortcuts/ActiveContexts.js\":\"ebb498656bddd4cf\",\"/knowledge-medium/src/shortcuts/HotkeyReconciler.js\":\"906354bbfaf25347\",\"/knowledge-medium/src/shortcuts/WipeLocalDataDialog.js\":\"2af0b8e2903689d6\",\"/knowledge-medium/src/shortcuts/actionDispatch.js\":\"ca75731970d70763\",\"/knowledge-medium/src/shortcuts/actionRefItems.js\":\"da78d4be38b62669\",\"/knowledge-medium/src/shortcuts/applyKeybindingOverrides.js\":\"e71da6a5d15885b4\",\"/knowledge-medium/src/shortcuts/blockActions.js\":\"15406d224015e66c\",\"/knowledge-medium/src/shortcuts/blockMergeGesture.js\":\"3439f270f32aabd8\",\"/knowledge-medium/src/shortcuts/canonicalizeChord.js\":\"d33ab4166df8f001\",\"/knowledge-medium/src/shortcuts/defaultContexts.js\":\"cd00efbd5e0b8d0d\",\"/knowledge-medium/src/shortcuts/defaultShortcuts.js\":\"5967761baafd2882\",\"/knowledge-medium/src/shortcuts/effectiveActions.js\":\"553bc176d7aa9ab1\",\"/knowledge-medium/src/shortcuts/gestureAction.js\":\"4b01b8aab4e00ae1\",\"/knowledge-medium/src/shortcuts/gestureBinding.js\":\"ae0576355adbc2b2\",\"/knowledge-medium/src/shortcuts/holdRegistry.js\":\"148e73a8e179666f\",\"/knowledge-medium/src/shortcuts/keybindingConflicts.js\":\"16e1563c8944f404\",\"/knowledge-medium/src/shortcuts/keybindingOverrides.js\":\"cc3c134ac255610a\",\"/knowledge-medium/src/shortcuts/pointerAction.js\":\"4473d21c58efd12c\",\"/knowledge-medium/src/shortcuts/resolve.js\":\"4a73fd959d0be37b\",\"/knowledge-medium/src/shortcuts/runAction.js\":\"bb30bd4a729e0d99\",\"/knowledge-medium/src/shortcuts/sequenceMatcher.js\":\"78fc619c6df72ebc\",\"/knowledge-medium/src/shortcuts/types.js\":\"0d83e17fb5000236\",\"/knowledge-medium/src/shortcuts/useActionContext.js\":\"0070495ba72c581c\",\"/knowledge-medium/src/shortcuts/useActionDiscovery.js\":\"c8fd53734f70f751\",\"/knowledge-medium/src/shortcuts/utils.js\":\"8f218d32d4987118\",\"/knowledge-medium/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/src/sw/bootStore.js\":\"6dffa9e402ef9854\",\"/knowledge-medium/src/sw/previewDatabases.js\":\"fd618f5c5cbda71a\",\"/knowledge-medium/src/sync/byteTransform.js\":\"75476506195c9b69\",\"/knowledge-medium/src/sync/conversion/attachmentCleaner.js\":\"88aff962b01796ba\",\"/knowledge-medium/src/sync/conversion/bundle/attachmentParts.js\":\"e58f6fff22da6ea5\",\"/knowledge-medium/src/sync/conversion/bundle/bundleParts.js\":\"e698484b199db850\",\"/knowledge-medium/src/sync/conversion/bundle/bundleRecord.js\":\"8ba9e00314ce4e3b\",\"/knowledge-medium/src/sync/conversion/bundle/manifest.js\":\"b89a05592d6b7f09\",\"/knowledge-medium/src/sync/conversion/bundle/takeBundle.js\":\"c25a24078468197b\",\"/knowledge-medium/src/sync/conversion/bundle/verifyBundle.js\":\"62ed6d5b95a2b6ee\",\"/knowledge-medium/src/sync/conversion/cleaningStage.js\":\"dc12e22f82f9abfd\",\"/knowledge-medium/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/src/sync/conversion/conversionKey.js\":\"e13b62e3d5848293\",\"/knowledge-medium/src/sync/conversion/conversionServer.js\":\"596864d15679c395\",\"/knowledge-medium/src/sync/conversion/flip.js\":\"f62609a4f216cca5\",\"/knowledge-medium/src/sync/conversion/flipAttempts.js\":\"1547234f67e577a3\",\"/knowledge-medium/src/sync/conversion/pages.js\":\"fc6f54f7f713d37c\",\"/knowledge-medium/src/sync/conversion/preflight.js\":\"b959d807aa2e5f5f\",\"/knowledge-medium/src/sync/conversion/reseal.js\":\"5093a7e8e4b8c280\",\"/knowledge-medium/src/sync/conversion/runConversion.js\":\"a8ec78cc63a3644c\",\"/knowledge-medium/src/sync/conversion/runLock.js\":\"21c7f75e0ee7fa5b\",\"/knowledge-medium/src/sync/conversion/sealing.js\":\"76b772c335a4ac93\",\"/knowledge-medium/src/sync/conversion/sealingStage.js\":\"ba59e327b75f4c90\",\"/knowledge-medium/src/sync/conversion/stage.js\":\"ae11a42f6ce56982\",\"/knowledge-medium/src/sync/conversion/verifyReseal.js\":\"ce3e78bc25406094\",\"/knowledge-medium/src/sync/crypto/aad.js\":\"7dbdc0918d5c890e\",\"/knowledge-medium/src/sync/crypto/aead.js\":\"def3fb5e0a5844ec\",\"/knowledge-medium/src/sync/crypto/base32.js\":\"8adc1f400d36ba7c\",\"/knowledge-medium/src/sync/crypto/base64url.js\":\"f10daa3d6f448fb4\",\"/knowledge-medium/src/sync/crypto/binaryEnvelope.js\":\"f664e8cc87466b47\",\"/knowledge-medium/src/sync/crypto/byteAead.js\":\"85ff5b921f03626b\",\"/knowledge-medium/src/sync/crypto/canary.js\":\"17bf20b3d89b2c47\",\"/knowledge-medium/src/sync/crypto/contentHash.js\":\"549eecd791c3e540\",\"/knowledge-medium/src/sync/crypto/contentKey.js\":\"95ea516398ddf5a3\",\"/knowledge-medium/src/sync/crypto/derivedIdNamespace.js\":\"a4f1124a00833ec1\",\"/knowledge-medium/src/sync/crypto/envelope.js\":\"8003d5758247368d\",\"/knowledge-medium/src/sync/crypto/hex.js\":\"f3b4070d5f1db17d\",\"/knowledge-medium/src/sync/crypto/sha256Hex.js\":\"0aad857c88e4e1ea\",\"/knowledge-medium/src/sync/crypto/workspaceKey.js\":\"343f7e1795618b1d\",\"/knowledge-medium/src/sync/keys/conversionState.js\":\"0d244a1be57dd79f\",\"/knowledge-medium/src/sync/keys/flows/createEncryptedWorkspace.js\":\"aa9325d412a17d45\",\"/knowledge-medium/src/sync/keys/flows/pastedKey.js\":\"95301e0c5506c69e\",\"/knowledge-medium/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"b56b9a27b9305916\",\"/knowledge-medium/src/sync/keys/flows/upgradeWorkspacePin.js\":\"067a27e5679be24a\",\"/knowledge-medium/src/sync/keys/keyStore.js\":\"8b736a55cdc5be8c\",\"/knowledge-medium/src/sync/keys/mintWorkspaceKey.js\":\"79e8107d24035a2a\",\"/knowledge-medium/src/sync/keys/modePin.js\":\"c7002344dea088d1\",\"/knowledge-medium/src/sync/keys/openWorkspaceKeys.js\":\"3392d036b1e6884f\",\"/knowledge-medium/src/sync/keys/resolveWorkspaceEntry.js\":\"1ad891e8458dd490\",\"/knowledge-medium/src/sync/keys/resolver.js\":\"cd717fadd8cd26b7\",\"/knowledge-medium/src/sync/keys/workspaceAccess.js\":\"bb32e93523024ab9\",\"/knowledge-medium/src/sync/transform.js\":\"183b7889cb7e63ea\",\"/knowledge-medium/src/themeBootDefaults.js\":\"2c641c3b411ef1fd\",\"/knowledge-medium/src/types.js\":\"28581bc47c9bb71e\",\"/knowledge-medium/src/utils/ClientLocalSettings.js\":\"b07f0f6d0b60f04e\",\"/knowledge-medium/src/utils/abortableSleep.js\":\"360ca76cd9298fc6\",\"/knowledge-medium/src/utils/array.js\":\"9d4865af1bae20ca\",\"/knowledge-medium/src/utils/backlinkAutocomplete.js\":\"97af79d28d3eab3f\",\"/knowledge-medium/src/utils/blockCrumbs.js\":\"acdef07da46ad98e\",\"/knowledge-medium/src/utils/blockrefAutocomplete.js\":\"5a06d5ee9a622514\",\"/knowledge-medium/src/utils/cadencedIdleJob.js\":\"9089de528f3011ed\",\"/knowledge-medium/src/utils/callbackSet.js\":\"2e8648296ee1709a\",\"/knowledge-medium/src/utils/clientId.js\":\"3b7914beb9805a1d\",\"/knowledge-medium/src/utils/codemirror.js\":\"ea38338104253703\",\"/knowledge-medium/src/utils/codemirrorCompletion.js\":\"83f6dbc912ef0510\",\"/knowledge-medium/src/utils/copy.js\":\"383905a12a6652e6\",\"/knowledge-medium/src/utils/dailyPage.js\":\"94bf9f67411d23ba\",\"/knowledge-medium/src/utils/dbForensics.js\":\"10259ce25b2ab385\",\"/knowledge-medium/src/utils/dbForensicsHooks.js\":\"18472d2b9dab544d\",\"/knowledge-medium/src/utils/deleteBlockThroughUi.js\":\"f60e5153e7f7e81d\",\"/knowledge-medium/src/utils/dialogs.js\":\"260561e27051c41b\",\"/knowledge-medium/src/utils/dom.js\":\"a562c57e40264e10\",\"/knowledge-medium/src/utils/downloadBlob.js\":\"221b986a57a2e1b8\",\"/knowledge-medium/src/utils/drawnWalk.js\":\"72ecdc270a807e26\",\"/knowledge-medium/src/utils/exportSqliteDb.js\":\"8ae56add471ddda8\",\"/knowledge-medium/src/utils/fileSystemAccess.js\":\"4ef5c196a150ebed\",\"/knowledge-medium/src/utils/flipSlide.js\":\"d91192211eaba074\",\"/knowledge-medium/src/utils/fnv1a.js\":\"abb98dd5070b9bda\",\"/knowledge-medium/src/utils/formatBytes.js\":\"d6404186cc720ef3\",\"/knowledge-medium/src/utils/fuzzyRank.js\":\"1333699019574723\",\"/knowledge-medium/src/utils/idbKeyedStore.js\":\"4f71177640ac9a80\",\"/knowledge-medium/src/utils/idleCallbackPolyfill.js\":\"86499f92cd1feba0\",\"/knowledge-medium/src/utils/keyboardAwareScroll.js\":\"e647ca94ab2a9b3f\",\"/knowledge-medium/src/utils/keyboardViewport.js\":\"d2758751baa66495\",\"/knowledge-medium/src/utils/lastWorkspace.js\":\"9c8a9ec848e4e092\",\"/knowledge-medium/src/utils/layoutColumns.js\":\"fefe63d0ed77d172\",\"/knowledge-medium/src/utils/layoutSessionDom.js\":\"24c358ce6914312b\",\"/knowledge-medium/src/utils/layoutSessionId.js\":\"45460c044e083b55\",\"/knowledge-medium/src/utils/linkClickGestures.js\":\"ee8b2343f33c0fa7\",\"/knowledge-medium/src/utils/linkTargetAutocomplete.js\":\"d4109b79c5475830\",\"/knowledge-medium/src/utils/localDbCorruption.js\":\"9e501e602f7450cc\",\"/knowledge-medium/src/utils/localDbRecovery.js\":\"2dfc241ebb2271c6\",\"/knowledge-medium/src/utils/markdownParser.js\":\"344df07e32a46264\",\"/knowledge-medium/src/utils/memoize.js\":\"0836cfcd5074a666\",\"/knowledge-medium/src/utils/nameFieldCommit.js\":\"dfcc6667737f5cb4\",\"/knowledge-medium/src/utils/nameList.js\":\"d912197ed61e7501\",\"/knowledge-medium/src/utils/navigation.js\":\"c00cbecf818e2223\",\"/knowledge-medium/src/utils/omnilinerNamespace.js\":\"651af0ef925ac5ab\",\"/knowledge-medium/src/utils/opfsPageScan.js\":\"9c32659914f2f371\",\"/knowledge-medium/src/utils/panelClearance.js\":\"d3083726353ccb57\",\"/knowledge-medium/src/utils/panelHistory.js\":\"bb56292a03f3fad8\",\"/knowledge-medium/src/utils/panelLanes.js\":\"bdd13c5af1a46a28\",\"/knowledge-medium/src/utils/panelLayoutProjection.js\":\"87a5b789138ff291\",\"/knowledge-medium/src/utils/panelScrollAnchor.js\":\"b9e7b9b2194b0b5b\",\"/knowledge-medium/src/utils/panelUrlFlags.js\":\"1ce5313bf8f78479\",\"/knowledge-medium/src/utils/platform.js\":\"47c4e66a7c568839\",\"/knowledge-medium/src/utils/pluralize.js\":\"c282797aad5ef31a\",\"/knowledge-medium/src/utils/propertyCreation.js\":\"513d53813950c9b3\",\"/knowledge-medium/src/utils/propertyNavigation.js\":\"7b4b5f9bfff7361c\",\"/knowledge-medium/src/utils/propertyValueContext.js\":\"83ccf0eda37336db\",\"/knowledge-medium/src/utils/react.js\":\"0388d6eef120b59f\",\"/knowledge-medium/src/utils/relativeDate.js\":\"95ec9ae84af631fc\",\"/knowledge-medium/src/utils/relativeTime.js\":\"3cdb81cc12c85ea1\",\"/knowledge-medium/src/utils/renderScope.js\":\"fa1689f6eabe360a\",\"/knowledge-medium/src/utils/resolvedThenable.js\":\"12a0194accf33715\",\"/knowledge-medium/src/utils/routing.js\":\"ca07fd461424625c\",\"/knowledge-medium/src/utils/safeMode.js\":\"2b5e1f1f432bd142\",\"/knowledge-medium/src/utils/scheduleIdle.js\":\"c5885bff6cb7cef0\",\"/knowledge-medium/src/utils/screenWakeLock.js\":\"be3c25522e20f942\",\"/knowledge-medium/src/utils/selection.js\":\"ef590c4f22c59ff7\",\"/knowledge-medium/src/utils/softKeyboardGrab.js\":\"bac0d3b8003de0ae\",\"/knowledge-medium/src/utils/startupTimeline.js\":\"74f891266510fa0d\",\"/knowledge-medium/src/utils/state.js\":\"58e10303bec200aa\",\"/knowledge-medium/src/utils/string.js\":\"3c23c685478567c2\",\"/knowledge-medium/src/utils/surfaceZoom.js\":\"afe14c8296a18a37\",\"/knowledge-medium/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/src/utils/time.js\":\"74fecac7289e0eea\",\"/knowledge-medium/src/utils/toast.js\":\"e8cc4df23288e100\",\"/knowledge-medium/src/utils/toggleStore.js\":\"1a3f26ae1febd3d0\",\"/knowledge-medium/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/src/utils/untilStopped.js\":\"085434f477b2e41c\",\"/knowledge-medium/src/utils/userActivity.js\":\"a22615da050f7f6b\",\"/knowledge-medium/src/utils/viewTransition.js\":\"339b05a62547d609\",\"/knowledge-medium/src/utils/viewport.js\":\"fcb1eedfd4804829\",\"/knowledge-medium/src/utils/webLock.js\":\"ffde68e1c7c3d3e2\",\"/knowledge-medium/src/utils/workspaceRecovery.js\":\"3c731bd97ee7f4df\",\"/knowledge-medium/src/utils/workspaceSnapshotStore.js\":\"f8ff140c2db701d8\",\"/knowledge-medium/src/vendor/react-compiler-runtime.js\":\"9fc20c3c79bb29c1\",\"/knowledge-medium/src/vendor/react-dom-client.js\":\"c90039bcf87f0e6e\",\"/knowledge-medium/src/vendor/react-dom-server-edge.js\":\"ebdbd9e914a9cb77\",\"/knowledge-medium/src/vendor/react-dom-server.js\":\"9dccad8685344220\",\"/knowledge-medium/src/vendor/react-dom-static-edge.js\":\"980619cf177fec7d\",\"/knowledge-medium/src/vendor/react-dom-static.js\":\"db1445bfa8ade9c1\",\"/knowledge-medium/src/vendor/react-dom-test-utils.js\":\"cd7585e83fd6b7b1\",\"/knowledge-medium/src/vendor/react-dom.js\":\"f1de8f4c9e9f2070\",\"/knowledge-medium/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/src/vendor/react-jsx-runtime.js\":\"6572107ec328b6da\",\"/knowledge-medium/src/vendor/react.js\":\"837dfeb1fd3b7de5\",\"/knowledge-medium/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
